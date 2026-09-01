#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
BACKUP_SCRIPT="${HOSTINGER_BACKUP_SCRIPT:-$SCRIPT_DIR/backup-data.sh}"
DEPLOY_PHASE="${HOSTINGER_DEPLOY_PHASE:-}"

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

pooled_backend_id="$(docker ps -aq \
  --filter 'label=com.docker.compose.project=streamx' \
  --filter 'label=com.docker.compose.service=backend-2' | head -n1)"

if [[ -n "$pooled_backend_id" && -z "$DEPLOY_PHASE" ]]; then
  log "Refusing deployment: a pooled backend topology is present but HOSTINGER_DEPLOY_PHASE is unset."
  log "Set HOSTINGER_DEPLOY_PHASE=phase5 to update every backend and PgBouncer service together."
  exit 1
fi

if [[ -n "$DEPLOY_PHASE" ]]; then
  log "Rebuilding the complete $DEPLOY_PHASE topology."
  "$SCRIPT_DIR/deploy-phases.sh" "$DEPLOY_PHASE"
else
  log "Rebuilding and starting the single-backend topology without removing unrelated services."
  compose up -d --build
fi
wait_for_backend_health

log "Running Django production checks."
compose exec -T backend python manage.py check --deploy

log "Deployment complete."
compose ps
