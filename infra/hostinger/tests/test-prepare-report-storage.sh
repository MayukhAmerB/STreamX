#!/usr/bin/env bash
# prepare-report-storage.sh: both upgrade paths, with a fake `docker` CLI.
#   (a) the old streamx_backend_private_media volume never existed;
#   (b) it exists with report files (and keeps receiving files until the old
#       containers are replaced).
# The old volume must never be modified or removed, copies are verified by
# SHA-256, everything is idempotent, and /etc/fstab gets exactly one
# noexec,nosuid,nodev line per directory.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../prepare-report-storage.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# --- fake docker --------------------------------------------------------------
mkdir -p "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1 $2" in
  "volume inspect")
    name="${*: -1}"
    [[ "$name" == "streamx_backend_private_media" && -n "${FAKE_LEGACY_DIR:-}" && -d "$FAKE_LEGACY_DIR" ]] || exit 1
    if [[ "$3" == "--format" ]]; then printf '%s\n' "$FAKE_LEGACY_DIR"; else printf '[{"Name":"%s"}]\n' "$name"; fi
    ;;
  "ps -q")
    printf '%s' "${FAKE_DOCKER_PS:-}"
    ;;
  *)
    exit 0
    ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/docker"
export PATH="$TEST_ROOT/bin:$PATH"
export STREAMX_STORAGE_SKIP_MOUNT=1
export STREAMX_STORAGE_ALLOW_NON_ROOT=1

is_linux=0
[[ "$(uname -s)" == "Linux" ]] && is_linux=1

mode_of() {
  stat -c %a "$1"
}

tree_digest() {
  (cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum)
}

setup_case() {
  local name="$1"
  CASE_DIR="$TEST_ROOT/$name"
  mkdir -p "$CASE_DIR"
  export STREAMX_REPORTS_HOST_DIR="$CASE_DIR/srv/streamx/reports"
  export STREAMX_REPORTS_QUARANTINE_DIR="$CASE_DIR/srv/streamx/reports-quarantine"
  export STREAMX_FSTAB_FILE="$CASE_DIR/fstab"
  export FAKE_DOCKER_LOG="$CASE_DIR/docker.log"
  export FAKE_LEGACY_DIR=""
  export FAKE_DOCKER_PS=""
  printf '# existing\nUUID=abc / ext4 defaults 0 1\n' > "$STREAMX_FSTAB_FILE"
  : > "$FAKE_DOCKER_LOG"
}

assert_no_volume_removal() {
  if grep -Eq '(^| )(volume rm|volume prune|rm -v|system prune)' "$FAKE_DOCKER_LOG"; then
    fail "the script tried to remove a Docker volume: $(cat "$FAKE_DOCKER_LOG")"
  fi
}

assert_fstab_once() {
  local dir
  for dir in "$STREAMX_REPORTS_HOST_DIR" "$STREAMX_REPORTS_QUARANTINE_DIR"; do
    [[ "$(grep -Fxc "$dir $dir none bind,noexec,nosuid,nodev 0 0" "$STREAMX_FSTAB_FILE")" == "1" ]] \
      || fail "fstab must hold exactly one noexec entry for $dir"
  done
  grep -Fqx 'UUID=abc / ext4 defaults 0 1' "$STREAMX_FSTAB_FILE" || fail "existing fstab lines must be kept"
}

# --- (a) no legacy volume ------------------------------------------------------------
setup_case fresh
bash "$SCRIPT" prepare
bash "$SCRIPT" prepare   # idempotent
[[ -d "$STREAMX_REPORTS_HOST_DIR" && -d "$STREAMX_REPORTS_QUARANTINE_DIR" ]] || fail "directories not created"
assert_fstab_once
if (( is_linux )); then
  [[ "$(mode_of "$STREAMX_REPORTS_HOST_DIR")" == "750" ]] || fail "reports dir must be 0750"
  [[ "$(mode_of "$STREAMX_REPORTS_QUARANTINE_DIR")" == "700" ]] || fail "quarantine dir must be 0700"
fi
bash "$SCRIPT" finalize
grep -Fqx 'result=absent' "$STREAMX_REPORTS_HOST_DIR/.migration/legacy-volume.done" || fail "absent volume not recorded"
bash "$SCRIPT" finalize 2>&1 | grep -Fq 'already recorded' || fail "second finalize must be a no-op"
assert_no_volume_removal
bash "$SCRIPT" status >/dev/null 2>&1 || fail "status must succeed"

# --- (b) legacy volume with files --------------------------------------------------
setup_case legacy
export FAKE_LEGACY_DIR="$CASE_DIR/legacy-volume"
mkdir -p "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10" "$FAKE_LEGACY_DIR/reports/feedback/2026/10"
printf '%%PDF-1.4 week one' > "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10/aa11.pdf"
printf 'feedback notes' > "$FAKE_LEGACY_DIR/reports/feedback/2026/10/bb22.docx"
printf '#!/bin/sh\necho owned\n' > "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10/cc33 with space.bin"
chmod 0755 "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10/cc33 with space.bin"
ln -s /etc/passwd "$FAKE_LEGACY_DIR/reports/link-to-passwd" 2>/dev/null || true
legacy_before="$(tree_digest "$FAKE_LEGACY_DIR")"

bash "$SCRIPT" prepare
for rel in reports/submissions/7/2026/10/aa11.pdf reports/feedback/2026/10/bb22.docx "reports/submissions/7/2026/10/cc33 with space.bin"; do
  cmp -s "$FAKE_LEGACY_DIR/$rel" "$STREAMX_REPORTS_HOST_DIR/$rel" || fail "pass 1 did not copy $rel"
done
if [[ -L "$FAKE_LEGACY_DIR/reports/link-to-passwd" ]]; then
  [[ ! -e "$STREAMX_REPORTS_HOST_DIR/reports/link-to-passwd" ]] || fail "symlinks must never be copied"
fi
if (( is_linux )); then
  [[ "$(mode_of "$STREAMX_REPORTS_HOST_DIR/reports/submissions/7/2026/10/cc33 with space.bin")" == "644" ]] \
    || fail "exec bits must be stripped from stored files"
fi
[[ ! -f "$STREAMX_REPORTS_HOST_DIR/.migration/legacy-volume.done" ]] || fail "pass 1 must not record the migration"

# The old containers keep writing until they are replaced.
printf 'late upload' > "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10/dd44.pdf"
legacy_before="$(tree_digest "$FAKE_LEGACY_DIR")"

export FAKE_DOCKER_PS="abc123"
if bash "$SCRIPT" finalize 2>"$CASE_DIR/finalize.err"; then
  fail "finalize must refuse while a container still mounts the old volume"
fi
grep -Fq 'still mount' "$CASE_DIR/finalize.err" || fail "missing in-use explanation"
[[ ! -f "$STREAMX_REPORTS_HOST_DIR/.migration/legacy-volume.done" ]] || fail "no marker while in use"

export FAKE_DOCKER_PS=""
bash "$SCRIPT" finalize 2>"$CASE_DIR/finalize.out"
cmp -s "$FAKE_LEGACY_DIR/reports/submissions/7/2026/10/dd44.pdf" "$STREAMX_REPORTS_HOST_DIR/reports/submissions/7/2026/10/dd44.pdf" \
  || fail "pass 2 did not copy the late upload"
marker="$STREAMX_REPORTS_HOST_DIR/.migration/legacy-volume.done"
grep -Fqx 'result=copied' "$marker" || fail "migration not recorded"
expected_files="$(cd "$FAKE_LEGACY_DIR" && find . -type f | wc -l | tr -d ' ')"
grep -Fqx "files_verified=$expected_files" "$marker" || fail "verified count wrong: $(cat "$marker")"
grep -Fq 'docker volume rm streamx_backend_private_media' "$CASE_DIR/finalize.out" || fail "manual cleanup hint missing"
[[ "$(tree_digest "$FAKE_LEGACY_DIR")" == "$legacy_before" ]] || fail "the old volume must stay untouched"
assert_no_volume_removal
assert_fstab_once

# Re-running everything changes nothing.
bash "$SCRIPT" prepare
bash "$SCRIPT" finalize
[[ "$(tree_digest "$FAKE_LEGACY_DIR")" == "$legacy_before" ]] || fail "re-run touched the old volume"

# --- conflicting content is never overwritten ------------------------------------------
setup_case conflict
export FAKE_LEGACY_DIR="$CASE_DIR/legacy-volume"
mkdir -p "$FAKE_LEGACY_DIR/reports" "$STREAMX_REPORTS_HOST_DIR/reports"
printf 'old bytes' > "$FAKE_LEGACY_DIR/reports/same-name.pdf"
printf 'new bytes' > "$STREAMX_REPORTS_HOST_DIR/reports/same-name.pdf"
if bash "$SCRIPT" prepare 2>/dev/null; then
  fail "differing files with the same name must stop the migration"
fi
[[ "$(cat "$STREAMX_REPORTS_HOST_DIR/reports/same-name.pdf")" == "new bytes" ]] || fail "existing file was overwritten"
assert_no_volume_removal

# --- a foreign fstab entry for the directory is not silently replaced --------------------
setup_case fstab-conflict
printf '%s %s none bind 0 0\n' "$STREAMX_REPORTS_HOST_DIR" "$STREAMX_REPORTS_HOST_DIR" >> "$STREAMX_FSTAB_FILE"
if bash "$SCRIPT" prepare 2>/dev/null; then
  fail "an fstab entry without noexec must stop the deploy"
fi

# --- script contract -----------------------------------------------------------------------
grep -Fq 'REPORTS_DIR="${STREAMX_REPORTS_HOST_DIR:-/srv/streamx/reports}"' "$SCRIPT"
grep -Fq 'QUARANTINE_DIR="${STREAMX_REPORTS_QUARANTINE_DIR:-/srv/streamx/reports-quarantine}"' "$SCRIPT"
grep -Fq 'MOUNT_OPTIONS="bind,noexec,nosuid,nodev"' "$SCRIPT"
grep -Fq 'mount -o "remount,$MOUNT_OPTIONS" "$dir"' "$SCRIPT"
# Only ever mentioned in comments and the operator hint, never executed.
if grep -Ev '^[[:space:]]*(#|log )' "$SCRIPT" | grep -Eq 'docker[[:space:]]+volume[[:space:]]+(rm|prune)'; then
  fail "the script must not run docker volume rm/prune"
fi

echo "Report storage preparation tests passed."
