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

set_env_value() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

get_env_value() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}

ensure_env_min_float() {
  local key="$1"
  local minimum="$2"
  local current
  current="$(get_env_value "$key")"
  current="$(echo "${current:-}" | xargs)"

  if [[ -z "${current// }" ]]; then
    set_env_value "$key" "$minimum"
    log "Resource profile applied: ${key}=${minimum} (was unset)."
    return
  fi

  if [[ ! "$current" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    set_env_value "$key" "$minimum"
    log "Resource profile applied: ${key}=${minimum} (replaced non-numeric value '${current}')."
    return
  fi

  if awk "BEGIN { exit !(${current} < ${minimum}) }"; then
    set_env_value "$key" "$minimum"
    log "Resource profile applied: ${key} raised from ${current} to ${minimum}."
  fi
}

is_truthy() {
  local value
  value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

apply_phase_runtime_profile() {
  local web_concurrency
  local gunicorn_threads
  case "$PHASE" in
    phase1|phase2|phase4)
      # Single backend container phases: keep deterministic moderate concurrency.
      set_env_value "WEB_CONCURRENCY" "2"
      set_env_value "GUNICORN_THREADS" "2"
      ;;
    phase3|phase5)
      # Backend-pool phases: reduce per-instance threading to protect DB headroom.
      set_env_value "WEB_CONCURRENCY" "2"
      set_env_value "GUNICORN_THREADS" "1"
      ;;
    *)
      ;;
  esac
  web_concurrency="$(grep '^WEB_CONCURRENCY=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  gunicorn_threads="$(grep '^GUNICORN_THREADS=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  web_concurrency="${web_concurrency:-unset}"
  gunicorn_threads="${gunicorn_threads:-unset}"
  log "Runtime profile applied: WEB_CONCURRENCY=${web_concurrency}, GUNICORN_THREADS=${gunicorn_threads}"
}

apply_phase_resource_profile() {
  case "$PHASE" in
    phase2|phase3|phase4|phase5)
      # Browser-host broadcasts depend on LiveKit participant egress.
      # Keep a floor that avoids the 1.5 vCPU profile timing out while still
      # preserving the rest of the Phase 5 application topology.
      ensure_env_min_float "LIVEKIT_EGRESS_CPUS" "3.0"
      # Give LiveKit participant egress enough time to attach to the published
      # browser tracks and start the RTMP pipeline on the single-node profile.
      ensure_env_min_float "LIVEKIT_EGRESS_TWIRP_TIMEOUT_SECONDS" "60"
      ;;
    *)
      ;;
  esac
}

compose_main() {
  docker compose --env-file "$ENV_FILE" "$@"
}

compose_observability() {
  docker compose --env-file "$ENV_FILE" -f "$OBS_COMPOSE" "$@"
}

reload_prometheus_config() {
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 5 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
      curl -fsS --max-time 10 -X POST http://127.0.0.1:9090/-/reload >/dev/null
      log "Prometheus configuration reloaded."
      return 0
    fi
    sleep 2
  done

  log "Prometheus did not become ready; configuration reload failed."
  return 1
}

prometheus_has_livekit_job() {
  curl -fsS --max-time 8 http://127.0.0.1:9090/api/v1/status/config 2>/dev/null |
    python3 -c 'import json,sys; config=json.load(sys.stdin).get("data", {}).get("yaml", ""); raise SystemExit(0 if "job_name: livekit" in config else 1)' \
      >/dev/null 2>&1
}

start_observability() {
  compose_observability up -d --remove-orphans
  reload_prometheus_config

  if prometheus_has_livekit_job; then
    log "Prometheus loaded the LiveKit scrape job."
    return 0
  fi

  # A long-running Prometheus container can retain an obsolete bind mount even
  # after a successful lifecycle reload. Recreate only Prometheus so the
  # current tracked configuration is mounted without touching application data.
  log "Prometheus did not load the LiveKit job; recreating only Prometheus."
  compose_observability up -d --no-deps --force-recreate prometheus
  reload_prometheus_config

  if ! prometheus_has_livekit_job; then
    log "Prometheus still does not expose the LiveKit scrape job after recreation."
    return 1
  fi

  log "Prometheus loaded the LiveKit scrape job after recreation."
}

ensure_redis_url() {
  local redis_url_value
  redis_url_value="$(grep '^REDIS_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  if [[ -z "${redis_url_value// }" ]]; then
    set_env_value "REDIS_URL" "redis://redis:6379/1"
    log "REDIS_URL was empty. Defaulted to redis://redis:6379/1 for shared cache/throttling reliability."
  fi
}

ensure_redis_url
apply_phase_runtime_profile
apply_phase_resource_profile
HOSTINGER_ENV_FILE="$ENV_FILE" bash "$SCRIPT_DIR/prepare-livekit-config.sh"

resolve_async_worker_replicas() {
  local replicas_raw
  replicas_raw="${ASYNC_WORKER_REPLICAS:-}"
  if [[ -z "${replicas_raw// }" ]]; then
    replicas_raw="$(get_env_value "ASYNC_WORKER_REPLICAS")"
  fi
  replicas_raw="$(echo "${replicas_raw:-1}" | xargs)"
  if [[ ! "$replicas_raw" =~ ^[0-9]+$ ]]; then
    replicas_raw="1"
  fi
  if (( replicas_raw < 1 )); then
    replicas_raw="1"
  fi
  echo "$replicas_raw"
}

scale_async_workers() {
  local enabled_value
  enabled_value="$(get_env_value "ASYNC_JOBS_ENABLED")"
  if ! is_truthy "$enabled_value"; then
    log "ASYNC_JOBS_ENABLED is not truthy; worker scaling skipped."
    return
  fi

  local replicas
  replicas="$(resolve_async_worker_replicas)"
  if (( replicas <= 1 )); then
    log "Async worker replicas: 1 (default)."
    return
  fi

  compose_main "$@" up -d --no-recreate --scale "worker=${replicas}" worker
  log "Async worker replicas scaled to ${replicas}."
}

phase1() {
  log "Phase 1: stable baseline (app + async worker + observability)."
  compose_main -f "$BASE_COMPOSE" -f "$ASYNC_COMPOSE" up -d --build --remove-orphans
  scale_async_workers -f "$BASE_COMPOSE" -f "$ASYNC_COMPOSE"
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  start_observability
}

phase2() {
  log "Phase 2: baseline + resource isolation limits."
  compose_main -f "$BASE_COMPOSE" -f "$LIMITS_COMPOSE" -f "$ASYNC_COMPOSE" up -d --build --remove-orphans
  scale_async_workers -f "$BASE_COMPOSE" -f "$LIMITS_COMPOSE" -f "$ASYNC_COMPOSE"
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  start_observability
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
  scale_async_workers \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_POOL_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$POOL_COMPOSE" \
    -f "$GATEWAY_COMPOSE"
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  start_observability
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
  scale_async_workers \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_PGBOUNCER_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$PGBOUNCER_COMPOSE" \
    -f "$POSTGRES_TUNING_COMPOSE"
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  start_observability
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
  scale_async_workers \
    -f "$BASE_COMPOSE" \
    -f "$LIMITS_COMPOSE" \
    -f "$LIMITS_POOL_COMPOSE" \
    -f "$LIMITS_PGBOUNCER_COMPOSE" \
    -f "$ASYNC_COMPOSE" \
    -f "$POOL_COMPOSE" \
    -f "$GATEWAY_COMPOSE" \
    -f "$PGBOUNCER_COMPOSE" \
    -f "$PGBOUNCER_POOL_COMPOSE" \
    -f "$POSTGRES_TUNING_COMPOSE"
  compose_main -f "$BASE_COMPOSE" exec -T backend python manage.py migrate
  start_observability
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
