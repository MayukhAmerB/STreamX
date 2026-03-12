#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
BASE_COMPOSE="$REPO_ROOT/docker-compose.hostinger.yml"
ASYNC_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.async-workers.yml"
LIMITS_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.resource-limits.yml"
LIMITS_POOL_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.resource-limits.pool.yml"
LIMITS_PGBOUNCER_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.resource-limits.pgbouncer.yml"
POOL_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.backend-pool.yml"
GATEWAY_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.gateway-lb.yml"
PGBOUNCER_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.pgbouncer.yml"
PGBOUNCER_POOL_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.pgbouncer.pool.yml"
POSTGRES_TUNING_COMPOSE="$REPO_ROOT/infra/hostinger/docker-compose.hostinger.postgres-tuning.yml"
OBS_COMPOSE="$REPO_ROOT/infra/observability/docker-compose.observability.yml"

PHASE="${1:-phase1}"

log() {
  printf '[hostinger-phase-deploy] %s\n' "$*"
}

compose_main() {
  docker compose --env-file "$ENV_FILE" "$@"
}

compose_observability() {
  docker compose -f "$OBS_COMPOSE" "$@"
}

phase1() {
  log "Phase 1: stable baseline (app + async worker + observability)."
  compose_main -f "$BASE_COMPOSE" -f "$ASYNC_COMPOSE" up -d --build --remove-orphans
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  compose_observability up -d --remove-orphans
}

phase2() {
  log "Phase 2: baseline + resource isolation limits."
  compose_main -f "$BASE_COMPOSE" -f "$LIMITS_COMPOSE" -f "$ASYNC_COMPOSE" up -d --build --remove-orphans
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  compose_observability up -d --remove-orphans
}

phase3() {
  log "Phase 3: phase2 + backend pool + optional internal gateway."
  compose_main \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_POOL_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$POOL_COMPOSE" \
    -f "$GATEWAY_COMPOSE" \
    up -d --build --remove-orphans
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  compose_observability up -d --remove-orphans
  log "If you want host-nginx to use gateway LB, proxy to 127.0.0.1:8088."
}

phase4() {
  log "Phase 4: phase2 + PgBouncer + PostgreSQL tuning."
  compose_main \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_PGBOUNCER_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$PGBOUNCER_COMPOSE" \
    -f "$POSTGRES_TUNING_COMPOSE" \
    up -d --build --remove-orphans
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  compose_observability up -d --remove-orphans
}

phase5() {
  log "Phase 5: phase3 + PgBouncer + PostgreSQL tuning."
  compose_main \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_POOL_COMPOSE" \
    -f "$LIMITS_PGBOUNCER_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$POOL_COMPOSE" \
    -f "$GATEWAY_COMPOSE" \
    -f "$PGBOUNCER_COMPOSE" \
    -f "$PGBOUNCER_POOL_COMPOSE" \
    -f "$POSTGRES_TUNING_COMPOSE" \
    up -d --build --remove-orphans
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  compose_observability up -d --remove-orphans
  log "If you want host-nginx to use gateway LB, proxy to 127.0.0.1:8088."
}

case "$PHASE" in
  phase1)
    phase1
    ;;
  phase2)
    phase2
    ;;
  phase3)
    phase3
    ;;
  phase4)
    phase4
    ;;
  phase5)
    phase5
    ;;
  *)
    log "Unknown phase: $PHASE"
    log "Usage: ./infra/hostinger/deploy-phases.sh phase1|phase2|phase3|phase4|phase5"
    exit 1
    ;;
esac

log "Deployment complete for $PHASE"
compose_main -f "$BASE_COMPOSE" ps
compose_observability ps
