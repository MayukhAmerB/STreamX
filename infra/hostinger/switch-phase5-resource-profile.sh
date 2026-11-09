#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
PROFILE_DIR="${HOSTINGER_PROFILE_DIR:-$SCRIPT_DIR/resource-profiles}"
backup_file=""
switch_succeeded=0

declare -a ALLOWED_KEYS=()
declare -a CHANGED_KEYS=()
declare -a RESTART_SERVICES=()
declare -a RESTART_ORDER=()
declare -a ORDERED_RESTART_SERVICES=()
declare -A PROFILE_VALUES=()

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

PROFILE_NAME="${1:-}"

usage() {
  cat <<'EOF'
Usage:
  ./infra/hostinger/switch-phase5-resource-profile.sh <content|broadcast|meeting>

What it does:
  - Backs up backend/.env.hostinger.production
  - Applies CPU values from the selected Phase 5 profile
  - Recreates only the services whose CPU settings changed

Profiles:
  content    Balanced/default profile for course/content delivery
  broadcast  OBS broadcast day profile (Owncast prioritized)
  meeting    Interactive meeting day profile (LiveKit prioritized)
EOF
}

log() {
  printf '[phase5-resource-profile] %s\n' "$*"
}

rollback_on_error() {
  local exit_code=$?
  if [[ "$exit_code" -eq 0 || "$switch_succeeded" -eq 1 ]]; then
    return 0
  fi

  if [[ -n "${backup_file:-}" && -f "$backup_file" ]]; then
    log "Failure detected. Restoring environment file from $backup_file"
    cp "$backup_file" "$ENV_FILE"

    if [[ "${#ORDERED_RESTART_SERVICES[@]}" -gt 0 ]]; then
      log "Attempting rollback recreate for services: ${ORDERED_RESTART_SERVICES[*]}"
      if compose_main up -d --no-deps "${ORDERED_RESTART_SERVICES[@]}"; then
        local service
        for service in "${ORDERED_RESTART_SERVICES[@]}"; do
          wait_for_service_ready "$service" || true
        done
      else
        log "Rollback recreate failed. Manual recovery may be required."
      fi
    fi
  fi

  exit "$exit_code"
}

compose_main() {
  docker compose \
    --env-file "$ENV_FILE" \
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
    "$@"
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

contains_value() {
  local needle="$1"
  shift || true
  local item
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
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

append_service_if_missing() {
  local service="$1"
  if ! contains_value "$service" "${RESTART_SERVICES[@]}"; then
    RESTART_SERVICES+=("$service")
  fi
}

register_services_for_key() {
  local key="$1"
  case "$key" in
    POSTGRES_CPUS)
      append_service_if_missing "postgres"
      ;;
    REDIS_CPUS)
      append_service_if_missing "redis"
      ;;
    BACKEND_CPUS)
      append_service_if_missing "backend"
      ;;
    BACKEND_POOL_CPUS)
      append_service_if_missing "backend-2"
      append_service_if_missing "backend-3"
      append_service_if_missing "backend-4"
      ;;
    WORKER_CPUS)
      append_service_if_missing "worker"
      ;;
    TRANSCODER_CPUS)
      append_service_if_missing "transcoder"
      ;;
    LIVEKIT_CPUS|LIVEKIT_EGRESS_CPUS)
      append_service_if_missing "livekit"
      append_service_if_missing "livekit-egress"
      ;;
    OWNCAST_CPUS)
      append_service_if_missing "owncast"
      ;;
    MEDIA_CPUS)
      append_service_if_missing "media"
      ;;
    FRONTEND_CPUS)
      append_service_if_missing "frontend"
      ;;
    GATEWAY_CPUS)
      append_service_if_missing "gateway"
      ;;
    PGBOUNCER_CPUS)
      append_service_if_missing "pgbouncer"
      ;;
    *)
      log "Skipping unsupported key mapping for ${key}."
      ;;
  esac
}

wait_for_service_ready() {
  local service="$1"
  local attempts=0
  local container_id=""

  container_id="$(compose_main ps -q "$service" | tail -n1)"
  if [[ -z "${container_id// }" ]]; then
    log "No container found for service ${service} after recreate."
    return 1
  fi

  until [[ "$attempts" -ge 40 ]]; do
    local state
    local run_status
    local health_status
    state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    run_status="${state%%|*}"
    health_status="${state#*|}"
    if [[ "$run_status" == "running" && ( "$health_status" == "healthy" || "$health_status" == "none" ) ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 3
  done

  log "Service ${service} did not become ready in time."
  return 1
}

if [[ -z "$PROFILE_NAME" ]]; then
  usage >&2
  exit 1
fi

PROFILE_FILE="$PROFILE_DIR/${PROFILE_NAME}.env"
if [[ ! -f "$PROFILE_FILE" ]]; then
  log "Profile file not found: $PROFILE_FILE"
  usage >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  log "Environment file not found: $ENV_FILE"
  exit 1
fi

ALLOWED_KEYS=(
  POSTGRES_CPUS
  REDIS_CPUS
  BACKEND_CPUS
  BACKEND_POOL_CPUS
  WORKER_CPUS
  TRANSCODER_CPUS
  LIVEKIT_CPUS
  LIVEKIT_EGRESS_CPUS
  OWNCAST_CPUS
  MEDIA_CPUS
  FRONTEND_CPUS
  GATEWAY_CPUS
  PGBOUNCER_CPUS
)
RESTART_ORDER=(
  postgres
  redis
  pgbouncer
  backend
  backend-2
  backend-3
  backend-4
  worker
  transcoder
  livekit
  livekit-egress
  owncast
  media
  frontend
  gateway
)

trap rollback_on_error EXIT

while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line="$(trim "$raw_line")"
  if [[ -z "$line" || "${line:0:1}" == "#" ]]; then
    continue
  fi
  if [[ "$line" != *=* ]]; then
    log "Invalid profile line: $raw_line"
    exit 1
  fi
  key="$(trim "${line%%=*}")"
  value="$(trim "${line#*=}")"
  if ! contains_value "$key" "${ALLOWED_KEYS[@]}"; then
    log "Unsupported profile key: $key"
    exit 1
  fi
  PROFILE_VALUES["$key"]="$value"
done < "$PROFILE_FILE"

if [[ "${#PROFILE_VALUES[@]}" -eq 0 ]]; then
  log "Profile file is empty: $PROFILE_FILE"
  exit 1
fi

for key in "${ALLOWED_KEYS[@]}"; do
  if [[ -z "${PROFILE_VALUES[$key]+x}" ]]; then
    continue
  fi
  next_value="${PROFILE_VALUES[$key]}"
  current_value="$(trim "$(get_env_value "$key")")"
  if [[ "$current_value" == "$next_value" ]]; then
    continue
  fi
  CHANGED_KEYS+=("$key")
  register_services_for_key "$key"
done

if [[ "${#CHANGED_KEYS[@]}" -eq 0 ]]; then
  log "Profile ${PROFILE_NAME} is already active. No changes applied."
  exit 0
fi

backup_file="${ENV_FILE}.profile-switch.$(date +%F-%H%M%S).bak"
cp "$ENV_FILE" "$backup_file"
log "Backed up environment file to $backup_file"

for key in "${CHANGED_KEYS[@]}"; do
  next_value="${PROFILE_VALUES[$key]}"
  current_value="$(trim "$(get_env_value "$key")")"
  set_env_value "$key" "$next_value"
  log "Applied ${key}=${next_value} (was ${current_value:-unset})"
done

log "Validating compose configuration for profile ${PROFILE_NAME}"
compose_main config >/dev/null

for service in "${RESTART_ORDER[@]}"; do
  if contains_value "$service" "${RESTART_SERVICES[@]}"; then
    ORDERED_RESTART_SERVICES+=("$service")
  fi
done

if [[ "${#ORDERED_RESTART_SERVICES[@]}" -eq 0 ]]; then
  log "No services need restart for profile ${PROFILE_NAME}."
  exit 0
fi

log "Recreating services for profile ${PROFILE_NAME}: ${ORDERED_RESTART_SERVICES[*]}"
compose_main up -d --no-deps "${ORDERED_RESTART_SERVICES[@]}"

for service in "${ORDERED_RESTART_SERVICES[@]}"; do
  wait_for_service_ready "$service"
done

switch_succeeded=1
log "Profile ${PROFILE_NAME} is now active."
compose_main ps
