#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BACKUP_ROOT="${HOSTINGER_BACKUP_ROOT:-$REPO_ROOT/.hostinger-backups}"
RETENTION_DAYS="${HOSTINGER_BACKUP_RETENTION_DAYS:-14}"
RETENTION_COUNT="${HOSTINGER_BACKUP_RETENTION_COUNT:-14}"
INCLUDE_REDIS_BACKUP="${HOSTINGER_BACKUP_INCLUDE_REDIS:-1}"
OFFSITE_COMMAND="${HOSTINGER_BACKUP_OFFSITE_COMMAND:-}"
TIMESTAMP="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$BACKUP_DIR"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

log() {
  printf '[hostinger-backup] %s\n' "$*"
}

wait_for_postgres() {
  local attempts=0
  until compose exec -T postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
      log "PostgreSQL did not become ready in time."
      return 1
    fi
    sleep 2
  done
}

backup_volume() {
  local volume_name="$1"
  local archive_name="$2"
  docker run --rm \
    -v "${volume_name}:/source:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine:3.20 \
    sh -lc "tar czf \"/backup/${archive_name}\" -C /source ."
}

verify_gzip_archive() {
  local archive_path="$1"
  if [ ! -f "$archive_path" ]; then
    log "Archive not found for verification: $archive_path"
    return 1
  fi
  gzip -t "$archive_path"
}

prune_backups() {
  local keep_count
  keep_count=$((RETENTION_COUNT))
  if [ "$keep_count" -gt 0 ]; then
    mapfile -t backup_dirs < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort)
    local total="${#backup_dirs[@]}"
    if [ "$total" -gt "$keep_count" ]; then
      local remove_count=$((total - keep_count))
      for ((idx = 0; idx < remove_count; idx++)); do
        local to_remove="${backup_dirs[$idx]}"
        if [ "$to_remove" != "$BACKUP_DIR" ]; then
          log "Pruning old backup (count): $to_remove"
          rm -rf -- "$to_remove"
        fi
      done
    fi
  fi

  local keep_days
  keep_days=$((RETENTION_DAYS))
  if [ "$keep_days" -gt 0 ]; then
    while IFS= read -r stale_dir; do
      if [ -z "$stale_dir" ] || [ "$stale_dir" = "$BACKUP_DIR" ]; then
        continue
      fi
      log "Pruning old backup (age): $stale_dir"
      rm -rf -- "$stale_dir"
    done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$keep_days" | sort)
  fi
}

run_offsite_sync() {
  if [ -z "$OFFSITE_COMMAND" ]; then
    return 0
  fi
  log "Running offsite backup command."
  HOSTINGER_BACKUP_DIR="$BACKUP_DIR" HOSTINGER_BACKUP_TIMESTAMP="$TIMESTAMP" sh -lc "$OFFSITE_COMMAND"
}

log "Ensuring PostgreSQL is running for logical backup."
compose up -d postgres >/dev/null
wait_for_postgres

log "Writing PostgreSQL dump."
compose exec -T postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' \
  | gzip -c > "${BACKUP_DIR}/postgres.sql.gz"

log "Archiving persistent volumes."
backup_volume "streamx_backend_media" "backend_media.tar.gz"
backup_volume "streamx_recordings_data" "recordings_data.tar.gz"
backup_volume "streamx_owncast_data" "owncast_data.tar.gz"
if [ "$INCLUDE_REDIS_BACKUP" = "1" ]; then
  backup_volume "streamx_redis_data" "redis_data.tar.gz"
fi

log "Verifying backup archives."
verify_gzip_archive "${BACKUP_DIR}/postgres.sql.gz"
verify_gzip_archive "${BACKUP_DIR}/backend_media.tar.gz"
verify_gzip_archive "${BACKUP_DIR}/recordings_data.tar.gz"
verify_gzip_archive "${BACKUP_DIR}/owncast_data.tar.gz"
if [ "$INCLUDE_REDIS_BACKUP" = "1" ] && [ -f "${BACKUP_DIR}/redis_data.tar.gz" ]; then
  verify_gzip_archive "${BACKUP_DIR}/redis_data.tar.gz"
fi

log "Writing checksums."
(
  cd "$BACKUP_DIR"
  sha256sum ./*.gz > sha256sums.txt
)

cat > "${BACKUP_DIR}/manifest.txt" <<EOF
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_file=${COMPOSE_FILE}
env_file=${ENV_FILE}
database_backup=postgres.sql.gz
media_backup=backend_media.tar.gz
recordings_backup=recordings_data.tar.gz
owncast_backup=owncast_data.tar.gz
redis_backup=$( [ "$INCLUDE_REDIS_BACKUP" = "1" ] && echo "redis_data.tar.gz" || echo "disabled" )
sha256_file=sha256sums.txt
retention_days=${RETENTION_DAYS}
retention_count=${RETENTION_COUNT}
EOF

ln -sfn "$BACKUP_DIR" "$BACKUP_ROOT/latest"
run_offsite_sync
prune_backups
log "Backup complete: ${BACKUP_DIR}"
