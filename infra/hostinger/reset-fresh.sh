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
  printf '[hostinger-reset] %s\n' "$*"
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

if [ "${HOSTINGER_RESET_CONFIRM:-0}" != "1" ]; then
  printf '[hostinger-reset] Refusing destructive reset without HOSTINGER_RESET_CONFIRM=1\n' >&2
  exit 1
fi

if [ -x "$BACKUP_SCRIPT" ]; then
  log "Creating safety backup before destructive reset."
  "$BACKUP_SCRIPT"
else
  log "Backup script is missing or not executable: $BACKUP_SCRIPT"
  exit 1
fi

log "Stopping and deleting the full Docker stack and all named volumes."
compose down --remove-orphans -v

log "Removing project images so the rebuild is fully fresh."
mapfile -t project_images < <(compose config --images | sort -u)
if [ "${#project_images[@]}" -gt 0 ]; then
  docker image rm -f "${project_images[@]}" >/dev/null 2>&1 || true
fi

log "Pulling the latest repository changes."
git -C "$REPO_ROOT" pull --ff-only

log "Pulling upstream service images and rebuilding local images without cache."
compose pull
compose build --pull --no-cache

log "Starting a fresh Hostinger stack."
compose up -d --force-recreate --remove-orphans
wait_for_backend_health

log "Running Django production checks."
compose exec -T backend python manage.py check --deploy

log "Fresh reset complete."
compose ps
