#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="$(cd -- "$SCRIPT_DIR/.." && pwd)/verify-backup.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

create_fixture() {
  local backup_name="$1"
  local created_at="$2"
  local backup_dir="$TEST_ROOT/backups/$backup_name"
  mkdir -p "$backup_dir" "$TEST_ROOT/empty"
  for archive in backend_media.tar.gz recordings_data.tar.gz owncast_data.tar.gz redis_data.tar.gz; do
    tar czf "$backup_dir/$archive" -C "$TEST_ROOT/empty" .
  done
  printf '%s\n' '-- StreamX backup fixture' | gzip -c > "$backup_dir/postgres.sql.gz"
  printf 'created_at_utc=%s\nredis_backup=redis_data.tar.gz\n' "$created_at" > "$backup_dir/manifest.txt"
  (cd "$backup_dir" && sha256sum ./*.gz > sha256sums.txt)
}

mkdir -p "$TEST_ROOT/backups" "$TEST_ROOT/metrics"
create_fixture current "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ln -s current "$TEST_ROOT/backups/latest"

HOSTINGER_BACKUP_ROOT="$TEST_ROOT/backups" \
HOSTINGER_BACKUP_METRICS_DIR="$TEST_ROOT/metrics" \
  "$VERIFY_SCRIPT" latest
grep -q 'streamx_backup_verification_success 1' "$TEST_ROOT/metrics/streamx_backup.prom"

create_fixture stale '2020-01-01T00:00:00Z'
if HOSTINGER_BACKUP_ROOT="$TEST_ROOT/backups" \
  HOSTINGER_BACKUP_METRICS_DIR="$TEST_ROOT/metrics" \
  "$VERIFY_SCRIPT" stale; then
  printf 'Expected stale backup verification to fail.\n' >&2
  exit 1
fi
grep -q 'streamx_backup_verification_success 0' "$TEST_ROOT/metrics/streamx_backup.prom"

printf 'Backup verifier tests passed.\n'
