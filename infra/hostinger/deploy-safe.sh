#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BACKUP_SCRIPT="${HOSTINGER_BACKUP_SCRIPT:-$SCRIPT_DIR/backup-data.sh}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

log() {
  printf '[hostinger-deploy] %s\n' "$*"
}

wait_for_backend_health() {
  local attempts=0
  local backend_container
  backend_container="$(compose ps -q backend)"
  if [ -z "$backend_container" ]; then
    log "Backend container was not created."
    return 1
  fi

  until [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$backend_container")" = "healthy" ]; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 40 ]; then
      log "Backend healthcheck did not reach healthy state."
      return 1
    fi
    sleep 3
  done
}

if [ -x "$BACKUP_SCRIPT" ]; then
  "$BACKUP_SCRIPT"
else
  log "Backup script is missing or not executable: $BACKUP_SCRIPT"
  exit 1
fi

log "Removing optional Docker edge nginx if it exists. Host nginx remains the public entrypoint."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile edge stop edge-nginx >/dev/null 2>&1 || true
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile edge rm -f edge-nginx >/dev/null 2>&1 || true

log "Rebuilding and starting persistent application services."
compose up -d --build
wait_for_backend_health

log "Running Django production checks."
compose exec -T backend python manage.py check --deploy

log "Deployment complete."
compose ps
