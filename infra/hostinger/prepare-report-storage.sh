#!/usr/bin/env bash
# Private, never-executed storage for weekly report files.
#
#   prepare-report-storage.sh prepare    before any `docker compose up/run`
#   prepare-report-storage.sh finalize   after the containers were recreated
#   prepare-report-storage.sh status     print what is in place (read-only)
#
# prepare (idempotent):
#   * creates /srv/streamx/reports (0750) and /srv/streamx/reports-quarantine
#     (0700), owned by root;
#   * makes each one its own mount point with noexec,nosuid,nodev (a self bind
#     mount, persisted in /etc/fstab). Docker bind mounts inherit those flags,
#     so nothing on them can ever be executed inside a container;
#   * if the release before this one stored report files in the named volume
#     streamx_backend_private_media, copies them over (pass 1, verified) while
#     the old containers keep running.
#
# finalize (idempotent): once no container uses that volume any more, copies
# what was written in the meantime (pass 2), verifies EVERY file of the volume
# against its copy by SHA-256 and records the migration. The old volume is
# never modified or deleted; remove it by hand after checking:
#   docker volume rm streamx_backend_private_media
#
# Test overrides: STREAMX_REPORTS_HOST_DIR, STREAMX_REPORTS_QUARANTINE_DIR,
# STREAMX_FSTAB_FILE, STREAMX_STORAGE_SKIP_MOUNT=1, STREAMX_STORAGE_ALLOW_NON_ROOT=1.
set -euo pipefail

REPORTS_DIR="${STREAMX_REPORTS_HOST_DIR:-/srv/streamx/reports}"
QUARANTINE_DIR="${STREAMX_REPORTS_QUARANTINE_DIR:-/srv/streamx/reports-quarantine}"
LEGACY_VOLUME="${STREAMX_LEGACY_REPORTS_VOLUME:-streamx_backend_private_media}"
FSTAB_FILE="${STREAMX_FSTAB_FILE:-/etc/fstab}"
SKIP_MOUNT="${STREAMX_STORAGE_SKIP_MOUNT:-0}"
ALLOW_NON_ROOT="${STREAMX_STORAGE_ALLOW_NON_ROOT:-0}"
MOUNT_OPTIONS="bind,noexec,nosuid,nodev"
STATE_DIR="$REPORTS_DIR/.migration"
MARKER="$STATE_DIR/legacy-volume.done"
ACTION="${1:-prepare}"

log() {
  printf '[report-storage] %s\n' "$*" >&2
}

die() {
  log "ERROR: $*"
  exit 1
}

require_root() {
  if [[ "$ALLOW_NON_ROOT" != "1" && "$(id -u)" != "0" ]]; then
    die "run as root (it creates /srv/streamx, edits /etc/fstab and mounts)."
  fi
}

ensure_dir() {
  local dir="$1" mode="$2"
  mkdir -p -- "$dir"
  if [[ "$ALLOW_NON_ROOT" != "1" ]]; then
    chown root:root -- "$dir"
  fi
  chmod "$mode" -- "$dir"
}

has_hardened_mount() {
  local dir="$1" target options
  target="$(findmnt -n -o TARGET --target "$dir" 2>/dev/null || true)"
  [[ "$target" == "$dir" ]] || return 1
  options=",$(findmnt -n -o OPTIONS --target "$dir" 2>/dev/null || true),"
  [[ "$options" == *,noexec,* && "$options" == *,nosuid,* && "$options" == *,nodev,* ]]
}

ensure_fstab_entry() {
  local dir="$1" line
  line="$dir $dir none $MOUNT_OPTIONS 0 0"
  touch -- "$FSTAB_FILE"
  if awk -v dir="$dir" '$1 == dir && $2 == dir { found = 1 } END { exit !found }' "$FSTAB_FILE"; then
    if ! grep -Fqx -- "$line" "$FSTAB_FILE"; then
      die "$FSTAB_FILE has a different entry for $dir; expected: $line"
    fi
    return 0
  fi
  printf '%s\n' "$line" >> "$FSTAB_FILE"
  log "Added to $FSTAB_FILE: $line"
}

ensure_hardened_mount() {
  local dir="$1"
  ensure_fstab_entry "$dir"
  if [[ "$SKIP_MOUNT" == "1" ]]; then
    return 0
  fi
  if has_hardened_mount "$dir"; then
    return 0
  fi
  if [[ "$(findmnt -n -o TARGET --target "$dir" 2>/dev/null || true)" != "$dir" ]]; then
    mount --bind "$dir" "$dir"
  fi
  # Flags given with the first bind are ignored by the kernel: remount.
  mount -o "remount,$MOUNT_OPTIONS" "$dir"
  has_hardened_mount "$dir" || die "$dir is not mounted $MOUNT_OPTIONS after remount."
  log "$dir mounted noexec,nosuid,nodev."
}

harden_tree() {
  local dir="$1"
  # Directories 0750, files without any exec bit or other-access (0640 at most).
  find "$dir" -mindepth 1 -type d -perm /0027 -exec chmod 0750 {} +
  find "$dir" -mindepth 1 -type f -perm /0137 -exec chmod u-x,g-wx,o-rwx {} +
}

legacy_volume_exists() {
  docker volume inspect "$LEGACY_VOLUME" >/dev/null 2>&1
}

legacy_volume_source() {
  local mountpoint
  mountpoint="$(docker volume inspect --format '{{ .Mountpoint }}' "$LEGACY_VOLUME")"
  [[ -n "$mountpoint" && -d "$mountpoint" ]] || die "cannot read the $LEGACY_VOLUME volume on the host ($mountpoint)."
  printf '%s' "$mountpoint"
}

sha_of() {
  sha256sum -- "$1" | awk '{ print $1 }'
}

# Copy every regular file of $1 into $2 that is not there yet (verified),
# and check that files already present are identical. Symlinks and special
# files are never followed or copied.
copy_tree_verified() {
  local src="$1" dst="$2" rel source target tmp copied=0 present=0 skipped=0
  [[ -n "$src" && -d "$src" && -n "$dst" && -d "$dst" ]] || die "copy_tree_verified: bad directories ($src -> $dst)."
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    source="$src/$rel"
    target="$dst/$rel"
    if [[ "$rel" == .migration || "$rel" == .migration/* ]]; then
      continue
    fi
    if [[ -L "$source" ]]; then
      log "Skipping symlink in legacy volume: $rel"
      skipped=$((skipped + 1))
      continue
    fi
    if [[ -d "$source" ]]; then
      mkdir -p -- "$target"
      chmod 0750 -- "$target"
      continue
    fi
    if [[ ! -f "$source" ]]; then
      log "Skipping special file in legacy volume: $rel"
      skipped=$((skipped + 1))
      continue
    fi
    mkdir -p -- "$(dirname -- "$target")"
    if [[ -e "$target" ]]; then
      [[ "$(sha_of "$source")" == "$(sha_of "$target")" ]] || die "$rel differs between $LEGACY_VOLUME and $dst; not overwriting."
      present=$((present + 1))
      continue
    fi
    tmp="$(dirname -- "$target")/.migrating.$$.$(basename -- "$target")"
    cp -p -- "$source" "$tmp"
    if [[ "$(sha_of "$source")" != "$(sha_of "$tmp")" ]]; then
      rm -f -- "$tmp"
      die "copy of $rel does not match its source."
    fi
    mv -f -- "$tmp" "$target"
    copied=$((copied + 1))
  done < <(cd "$src" && find . -mindepth 1 -print0)
  log "Legacy copy: $copied copied, $present already present, $skipped skipped."
}

verify_all_copied() {
  local src="$1" dst="$2" rel count=0
  [[ -n "$src" && -d "$src" ]] || die "verify_all_copied: bad source ($src)."
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    [[ -f "$dst/$rel" ]] || die "verification failed: $rel is missing from $dst."
    [[ "$(sha_of "$src/$rel")" == "$(sha_of "$dst/$rel")" ]] || die "verification failed: $rel differs."
    count=$((count + 1))
  done < <(cd "$src" && find . -type f -print0)
  printf '%s' "$count"
}

containers_using_legacy_volume() {
  docker ps -q --filter "volume=$LEGACY_VOLUME" 2>/dev/null || true
}

prepare() {
  require_root
  ensure_dir "$(dirname -- "$REPORTS_DIR")" 0755
  ensure_dir "$REPORTS_DIR" 0750
  ensure_dir "$QUARANTINE_DIR" 0700
  ensure_hardened_mount "$REPORTS_DIR"
  ensure_hardened_mount "$QUARANTINE_DIR"
  ensure_dir "$STATE_DIR" 0700
  if [[ ! -f "$MARKER" ]] && legacy_volume_exists; then
    local source
    source="$(legacy_volume_source)"
    log "Found the $LEGACY_VOLUME volume from an earlier release: copying its files (pass 1)."
    copy_tree_verified "$source" "$REPORTS_DIR"
  fi
  harden_tree "$REPORTS_DIR"
  log "Report storage ready: $REPORTS_DIR (0750) and $QUARANTINE_DIR (0700), $MOUNT_OPTIONS."
}

finalize() {
  require_root
  [[ -d "$REPORTS_DIR" ]] || die "$REPORTS_DIR does not exist; run '$0 prepare' first."
  ensure_dir "$STATE_DIR" 0700
  if [[ -f "$MARKER" ]]; then
    log "Legacy volume migration already recorded ($MARKER)."
    return 0
  fi
  if ! legacy_volume_exists; then
    printf 'migrated_at=%s\nlegacy_volume=%s\nresult=absent\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LEGACY_VOLUME" > "$MARKER"
    chmod 0600 -- "$MARKER"
    log "No $LEGACY_VOLUME volume: nothing to migrate."
    return 0
  fi
  local users
  users="$(containers_using_legacy_volume)"
  if [[ -n "$users" ]]; then
    die "containers still mount $LEGACY_VOLUME ($(echo "$users" | tr '\n' ' ')); finalize after they were recreated."
  fi
  local source count
  source="$(legacy_volume_source)"
  log "Copying files written to $LEGACY_VOLUME since pass 1 (pass 2)."
  copy_tree_verified "$source" "$REPORTS_DIR"
  count="$(verify_all_copied "$source" "$REPORTS_DIR")"
  harden_tree "$REPORTS_DIR"
  printf 'migrated_at=%s\nlegacy_volume=%s\nresult=copied\nfiles_verified=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LEGACY_VOLUME" "$count" > "$MARKER"
  chmod 0600 -- "$MARKER"
  log "Migrated and verified $count file(s) from $LEGACY_VOLUME (SHA-256)."
  log "The $LEGACY_VOLUME volume was left untouched. After checking downloads, remove it with:"
  log "  docker volume rm $LEGACY_VOLUME"
}

status() {
  local dir
  for dir in "$REPORTS_DIR" "$QUARANTINE_DIR"; do
    if [[ ! -d "$dir" ]]; then
      log "$dir: missing"
    elif [[ "$SKIP_MOUNT" != "1" ]] && has_hardened_mount "$dir"; then
      log "$dir: present, $MOUNT_OPTIONS"
    else
      log "$dir: present, NOT a noexec,nosuid,nodev mount"
    fi
  done
  if [[ -f "$MARKER" ]]; then
    log "Legacy migration: $(tr '\n' ' ' < "$MARKER")"
  else
    log "Legacy migration: not recorded yet"
  fi
}

case "$ACTION" in
  prepare) prepare ;;
  finalize) finalize ;;
  status) status ;;
  *) die "usage: $0 prepare|finalize|status" ;;
esac
