#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
BACKUP_ROOT="${HOSTINGER_BACKUP_ROOT:-$REPO_ROOT/.hostinger-backups}"
BACKUP_REF="${1:-latest}"
MAX_AGE_SECONDS="${HOSTINGER_BACKUP_MAX_AGE_SECONDS:-129600}"
REQUIRE_OFFSITE="${HOSTINGER_BACKUP_REQUIRE_OFFSITE:-0}"
METRICS_DIR="${HOSTINGER_BACKUP_METRICS_DIR:-/var/lib/streamx/node-exporter}"
BACKUP_DIR="$BACKUP_REF"

if [[ "$BACKUP_REF" != /* ]]; then
  BACKUP_DIR="$BACKUP_ROOT/$BACKUP_REF"
fi

log() {
  printf '[hostinger-backup-verify] %s\n' "$*"
}

write_metrics() {
  local success="$1"
  local backup_timestamp="${2:-0}"
  local now
  local age=0
  now="$(date +%s)"
  if [[ "$backup_timestamp" =~ ^[0-9]+$ ]] && (( backup_timestamp > 0 )); then
    age=$((now - backup_timestamp))
  fi
  install -d -m 0755 "$METRICS_DIR"
  local temporary_file="$METRICS_DIR/.streamx_backup.prom.$$"
  cat > "$temporary_file" <<EOF
# HELP streamx_backup_verification_success Whether the latest backup passed integrity and freshness checks.
# TYPE streamx_backup_verification_success gauge
streamx_backup_verification_success ${success}
# HELP streamx_backup_last_success_timestamp_seconds Unix timestamp of the newest verified backup.
# TYPE streamx_backup_last_success_timestamp_seconds gauge
streamx_backup_last_success_timestamp_seconds ${backup_timestamp}
# HELP streamx_backup_age_seconds Age of the backup inspected by the verifier.
# TYPE streamx_backup_age_seconds gauge
streamx_backup_age_seconds ${age}
EOF
  chmod 0644 "$temporary_file"
  mv -f "$temporary_file" "$METRICS_DIR/streamx_backup.prom"
}

backup_timestamp=0
verification_complete=0
on_exit() {
  local exit_code=$?
  if (( verification_complete == 0 )); then
    write_metrics 0 "$backup_timestamp" || true
  fi
  exit "$exit_code"
}
trap on_exit EXIT

if [[ ! -d "$BACKUP_DIR" ]]; then
  log "Backup directory not found: $BACKUP_DIR"
  exit 1
fi

BACKUP_DIR="$(cd -- "$BACKUP_DIR" && pwd -P)"

required_archives=(
  postgres.sql.gz
  backend_media.tar.gz
  recordings_data.tar.gz
  owncast_data.tar.gz
)
for archive in "${required_archives[@]}"; do
  if [[ ! -s "$BACKUP_DIR/$archive" ]]; then
    log "Required archive is missing or empty: $archive"
    exit 1
  fi
done

if [[ ! -s "$BACKUP_DIR/manifest.txt" || ! -s "$BACKUP_DIR/sha256sums.txt" ]]; then
  log "Backup manifest or checksum file is missing."
  exit 1
fi

created_at_utc="$(awk -F= '$1 == "created_at_utc" {print $2; exit}' "$BACKUP_DIR/manifest.txt")"
if [[ -z "$created_at_utc" ]] || ! backup_timestamp="$(date -d "$created_at_utc" +%s 2>/dev/null)"; then
  log "Backup manifest has an invalid created_at_utc value."
  exit 1
fi
age_seconds=$(($(date +%s) - backup_timestamp))
if (( age_seconds < 0 || age_seconds > MAX_AGE_SECONDS )); then
  log "Backup is outside the allowed age: ${age_seconds}s (maximum ${MAX_AGE_SECONDS}s)."
  exit 1
fi

redis_backup="$(awk -F= '$1 == "redis_backup" {print $2; exit}' "$BACKUP_DIR/manifest.txt")"
if [[ "$redis_backup" != "disabled" && ! -s "$BACKUP_DIR/${redis_backup:-redis_data.tar.gz}" ]]; then
  log "Manifest requires a Redis archive, but it is missing or empty."
  exit 1
fi
if [[ "$REQUIRE_OFFSITE" == "1" && ! -f "$BACKUP_DIR/offsite-sync.completed" ]]; then
  log "Offsite backup confirmation is required but missing."
  exit 1
fi

log "Verifying checksums in $BACKUP_DIR"
(cd "$BACKUP_DIR" && sha256sum -c sha256sums.txt)
for archive in "$BACKUP_DIR"/*.gz; do
  gzip -t "$archive"
done

write_metrics 1 "$backup_timestamp"
verification_complete=1
log "Backup verification passed; age=${age_seconds}s."
