#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BACKUP_ROOT="${HOSTINGER_BACKUP_ROOT:-$REPO_ROOT/.hostinger-backups}"
INCLUDE_REDIS_RESTORE="${HOSTINGER_RESTORE_INCLUDE_REDIS:-1}"
DRY_RUN="${HOSTINGER_RESTORE_DRY_RUN:-0}"
VALIDATE_HEALTH="${HOSTINGER_RESTORE_VALIDATE_HEALTH:-1}"
BACKEND_HEALTH_URL="${HOSTINGER_RESTORE_BACKEND_HEALTH_URL:-http://127.0.0.1:8000/health/ready}"
BACKEND_HEALTH_HOST_HEADER="${HOSTINGER_RESTORE_BACKEND_HOST_HEADER:-api.alsyedinitiative.com}"
BACKUP_REF="${1:-latest}"
BACKUP_DIR="$BACKUP_REF"

if [ "$BACKUP_REF" = "latest" ]; then
  BACKUP_DIR="$BACKUP_ROOT/latest"
elif [[ "$BACKUP_REF" != /* ]]; then
  BACKUP_DIR="$BACKUP_ROOT/$BACKUP_REF"
fi

if [ ! -d "$BACKUP_DIR" ]; then
  printf '[hostinger-restore] Backup directory not found: %s\n' "$BACKUP_DIR" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

log() {
  printf '[hostinger-restore] %s\n' "$*"
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

verify_backup_integrity() {
  if [ -f "${BACKUP_DIR}/sha256sums.txt" ]; then
    log "Verifying backup checksums."
    (cd "$BACKUP_DIR" && sha256sum -c sha256sums.txt)
    return 0
  fi

  log "Checksum manifest not found. Falling back to gzip integrity checks."
  local archive
  for archive in "${BACKUP_DIR}"/*.gz; do
    [ -f "$archive" ] || continue
    gzip -t "$archive"
  done
}

restore_volume() {
  local volume_name="$1"
  local archive_name="$2"
  local archive_path="${BACKUP_DIR}/${archive_name}"

  if [ ! -f "$archive_path" ]; then
    log "Skipping missing archive: ${archive_name}"
    return 0
  fi

  docker run --rm \
    -v "${volume_name}:/target" \
    -v "${BACKUP_DIR}:/backup:ro" \
    alpine:3.20 \
    sh -lc "rm -rf /target/* /target/.[!.]* /target/..?* 2>/dev/null || true; tar xzf \"/backup/${archive_name}\" -C /target"
}

validate_post_restore_health() {
  if [ "$VALIDATE_HEALTH" != "1" ]; then
    return 0
  fi
  log "Validating backend readiness endpoint after restore."
  curl -fsS \
    --max-time 8 \
    -H "Host: ${BACKEND_HEALTH_HOST_HEADER}" \
    -H "X-Forwarded-Proto: https" \
    "$BACKEND_HEALTH_URL" >/dev/null
}

verify_backup_integrity

if [ "$DRY_RUN" = "1" ]; then
  log "Dry-run mode enabled. Backup integrity checks passed for ${BACKUP_DIR}."
  exit 0
fi

if [ "${HOSTINGER_RESTORE_CONFIRM:-0}" != "1" ]; then
  printf '[hostinger-restore] Refusing destructive restore without HOSTINGER_RESTORE_CONFIRM=1\n' >&2
  exit 1
fi

log "Stopping application services before restore."
compose stop frontend backend media owncast livekit livekit-egress >/dev/null 2>&1 || true

log "Starting PostgreSQL for restore."
compose up -d postgres >/dev/null
wait_for_postgres

if [ ! -f "${BACKUP_DIR}/postgres.sql.gz" ]; then
  log "Database backup not found in ${BACKUP_DIR}"
  exit 1
fi

log "Restoring PostgreSQL dump."
compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"'
gzip -dc "${BACKUP_DIR}/postgres.sql.gz" \
  | compose exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'

log "Restoring persistent volumes."
restore_volume "streamx_backend_media" "backend_media.tar.gz"
restore_volume "streamx_recordings_data" "recordings_data.tar.gz"
restore_volume "streamx_owncast_data" "owncast_data.tar.gz"
if [ "$INCLUDE_REDIS_RESTORE" = "1" ]; then
  restore_volume "streamx_redis_data" "redis_data.tar.gz"
fi

log "Starting application services."
compose up -d

validate_post_restore_health

log "Restore complete from ${BACKUP_DIR}"
