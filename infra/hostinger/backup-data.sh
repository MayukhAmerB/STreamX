#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BACKUP_ROOT="${HOSTINGER_BACKUP_ROOT:-$REPO_ROOT/.hostinger-backups}"
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

cat > "${BACKUP_DIR}/manifest.txt" <<EOF
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_file=${COMPOSE_FILE}
env_file=${ENV_FILE}
database_backup=postgres.sql.gz
media_backup=backend_media.tar.gz
recordings_backup=recordings_data.tar.gz
owncast_backup=owncast_data.tar.gz
EOF

ln -sfn "$BACKUP_DIR" "$BACKUP_ROOT/latest"
log "Backup complete: ${BACKUP_DIR}"
