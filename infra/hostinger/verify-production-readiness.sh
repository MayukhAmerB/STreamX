#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
EXPECTED_COMMIT="${RELEASE_COMMIT:-}"
ALLOW_UNBACKED_RELEASE="${ALLOW_UNBACKED_RELEASE:-0}"
API_HEALTH_URL="${STREAMX_API_HEALTH_URL:-https://api.alsyedinitiative.com/health/ready}"
FRONTEND_HEALTH_URL="${STREAMX_FRONTEND_HEALTH_URL:-https://alsyedinitiative.com/}"
ORIGIN_DOMAINS="${STREAMX_ORIGIN_DOMAINS:-alsyedinitiative.com api.alsyedinitiative.com adlfront.com}"
failures=0

log() {
  printf '[production-readiness] %s\n' "$*"
}

fail() {
  log "FAIL: $*"
  failures=$((failures + 1))
}

pass() {
  log "PASS: $*"
}

warn() {
  log "WARNING: $*"
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

for command_name in git docker curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "Required command is unavailable: $command_name"
done

if [[ ! -f "$ENV_FILE" ]]; then
  fail "Production environment file is missing: $ENV_FILE"
else
  env_mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || printf 777)"
  if (( (8#$env_mode & 077) != 0 )); then
    fail "Production environment permissions are too broad ($env_mode); expected 600 or stricter."
  else
    pass "Production environment permissions are restricted."
  fi
fi

livekit_runtime_config="$(grep '^LIVEKIT_RUNTIME_CONFIG_PATH=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
livekit_runtime_config="${livekit_runtime_config%\"}"
livekit_runtime_config="${livekit_runtime_config#\"}"
livekit_runtime_config="${livekit_runtime_config%\'}"
livekit_runtime_config="${livekit_runtime_config#\'}"
livekit_runtime_config="${livekit_runtime_config:-/etc/streamx/livekit.yaml}"
if [[ ! -f "$livekit_runtime_config" ]]; then
  fail "LiveKit runtime configuration is missing: $livekit_runtime_config"
else
  livekit_config_mode="$(stat -c %a "$livekit_runtime_config" 2>/dev/null || printf 777)"
  if (( (8#$livekit_config_mode & 077) != 0 )); then
    fail "LiveKit runtime configuration permissions are too broad ($livekit_config_mode)."
  elif ! grep -Eq '^[[:space:]]*keys:[[:space:]]*$' "$livekit_runtime_config" || \
    ! grep -Eq '^[[:space:]]+"[A-Za-z0-9_-]{8,128}":[[:space:]]+"[A-Za-z0-9_-]{24,256}"[[:space:]]*$' "$livekit_runtime_config"; then
    fail "LiveKit runtime configuration has no valid credential pair."
  else
    pass "LiveKit runtime configuration exists with restricted permissions."
  fi
fi

egress_runtime_config="$(grep '^LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
egress_runtime_config="${egress_runtime_config%\"}"
egress_runtime_config="${egress_runtime_config#\"}"
egress_runtime_config="${egress_runtime_config%\'}"
egress_runtime_config="${egress_runtime_config#\'}"
egress_runtime_config="${egress_runtime_config:-/etc/streamx/egress.yaml}"
if [[ ! -f "$egress_runtime_config" ]]; then
  fail "LiveKit egress runtime configuration is missing: $egress_runtime_config"
else
  egress_config_mode="$(stat -c %a "$egress_runtime_config" 2>/dev/null || printf 777)"
  egress_config_owner="$(stat -c %u:%g "$egress_runtime_config" 2>/dev/null || printf unknown)"
  if [[ "$egress_config_mode" != "640" || "$egress_config_owner" != "0:0" ]]; then
    fail "LiveKit egress runtime configuration must be mode 640 and owned by root:root (found: $egress_config_mode $egress_config_owner)."
  elif ! grep -Eq '^[[:space:]]*api_key:[[:space:]]*"[A-Za-z0-9_-]{8,128}"[[:space:]]*$' "$egress_runtime_config" || \
    ! grep -Eq '^[[:space:]]*api_secret:[[:space:]]*"[A-Za-z0-9_-]{24,256}"[[:space:]]*$' "$egress_runtime_config"; then
    fail "LiveKit egress runtime configuration has no valid credential pair."
  else
    pass "LiveKit egress runtime configuration exists with restricted permissions."
  fi
fi

current_commit="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ -n "$EXPECTED_COMMIT" && "$current_commit" != "$EXPECTED_COMMIT" ]]; then
  fail "Current commit does not match RELEASE_COMMIT."
else
  pass "Release commit is ${current_commit:-unavailable}."
fi

if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules --; then
  fail "Tracked working tree has unstaged changes."
else
  pass "Tracked working tree has no unstaged changes."
fi
if ! git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules --; then
  fail "Tracked working tree has staged changes."
else
  pass "Tracked working tree has no staged changes."
fi

if compose config -q; then
  pass "Production Compose configuration is valid."
else
  fail "Production Compose configuration is invalid."
fi

if command -v nginx >/dev/null 2>&1; then
  if sudo nginx -t; then
    pass "Nginx configuration is valid."
  else
    fail "Nginx configuration is invalid."
  fi
  if [[ "$(systemctl is-active nginx 2>/dev/null)" == "active" ]]; then
    pass "Nginx is active."
  else
    fail "Nginx is not active."
  fi
  active_backups="$(find /etc/nginx/sites-enabled -maxdepth 1 \( -type f -o -type l \) \( -name '*.bak*' -o -name '*~' \) -print 2>/dev/null)"
  if [[ -n "$active_backups" ]]; then
    fail "Backup files are active under sites-enabled."
  else
    pass "No backup files are active under sites-enabled."
  fi
fi

backend_id="$(compose ps -q backend 2>/dev/null || true)"
if [[ -z "$backend_id" || "$(docker inspect -f '{{.State.Running}}' "$backend_id" 2>/dev/null)" != "true" ]]; then
  fail "Backend container is not running."
else
  pass "Backend container is running."
  if compose exec -T backend python manage.py check --deploy; then
    pass "Django production checks passed."
  else
    fail "Django production checks failed."
  fi
  pending_migrations="$(compose exec -T backend python manage.py showmigrations --plan 2>/dev/null | grep -E '^\[ \]' || true)"
  if [[ -n "$pending_migrations" ]]; then
    fail "Pending database migrations detected."
  else
    pass "No pending database migrations detected."
  fi
fi

livekit_id="$(compose ps -q livekit 2>/dev/null || true)"
if [[ -z "$livekit_id" || "$(docker inspect -f '{{.State.Running}}' "$livekit_id" 2>/dev/null)" != "true" ]]; then
  fail "LiveKit container is not running."
else
  livekit_binding="$(docker port "$livekit_id" 7880/tcp 2>/dev/null || true)"
  if [[ "$livekit_binding" != "127.0.0.1:7880" ]]; then
    fail "LiveKit signaling port is not restricted to 127.0.0.1:7880 (found: ${livekit_binding:-none})."
  elif curl -fsS --max-time 5 http://127.0.0.1:7880/ >/dev/null; then
    pass "LiveKit signaling is healthy and restricted to localhost."
  else
    fail "LiveKit signaling health check failed on localhost."
  fi
fi

for pooled_service in backend-2 backend-3 backend-4 payment-backend-1 payment-backend-2; do
  pooled_id="$(docker ps -aq \
    --filter 'label=com.docker.compose.project=streamx' \
    --filter "label=com.docker.compose.service=$pooled_service" | head -n1)"
  if [[ -z "$pooled_id" ]]; then
    continue
  fi
  pooled_running="$(docker inspect -f '{{.State.Running}}' "$pooled_id" 2>/dev/null || true)"
  pooled_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$pooled_id" 2>/dev/null || true)"
  if [[ "$pooled_running" != "true" || "$pooled_health" != "healthy" ]]; then
    fail "Pooled service $pooled_service is not healthy."
  else
    # Compose builds each pool service under a distinct image name, so image
    # IDs differ even when every service was rebuilt from the same source.
    pass "Pooled service $pooled_service is healthy."
  fi
done

if [[ "$ALLOW_UNBACKED_RELEASE" == "1" ]]; then
  warn "Backup freshness verification was explicitly skipped for this release."
elif "$SCRIPT_DIR/verify-backup.sh" latest; then
  pass "Latest backup is fresh and valid."
else
  fail "Latest backup verification failed."
fi

if curl -fsS --max-time 15 "$API_HEALTH_URL" >/dev/null; then
  pass "Public API readiness endpoint is healthy."
else
  fail "Public API readiness endpoint failed."
fi
if curl -fsS --max-time 15 "$FRONTEND_HEALTH_URL" >/dev/null; then
  pass "Public frontend is healthy."
else
  fail "Public frontend health check failed."
fi

for domain in $ORIGIN_DOMAINS; do
  origin_path="/"
  if [[ "$domain" == api.* ]]; then
    origin_path="/health/live"
  fi
  if curl -kfsS --max-time 10 \
    --resolve "$domain:443:127.0.0.1" \
    "https://$domain$origin_path" >/dev/null; then
    pass "Nginx origin routing is healthy for $domain."
  else
    fail "Nginx origin routing failed for $domain."
  fi
done

if curl -fsS --max-time 5 http://127.0.0.1:9090/-/ready >/dev/null 2>&1; then
  # Prometheus starts scraping asynchronously after a container restart. Wait
  # briefly so a newly started but healthy monitoring stack is not a false fail.
  target_summary="unknown"
  for attempt in 1 2 3 4 5 6; do
    target_summary="$(curl -fsS --max-time 8 http://127.0.0.1:9090/api/v1/targets 2>/dev/null | python3 -c 'import json,sys; targets=json.load(sys.stdin)["data"]["activeTargets"]; livekit=[target for target in targets if target.get("labels", {}).get("job") == "livekit"]; print(sum(1 for target in targets if target.get("health") != "up"), len(livekit), sum(1 for target in livekit if target.get("health") == "up"))' 2>/dev/null || printf unknown)"
    if [[ "$target_summary" =~ ^0[[:space:]]+[1-9][0-9]*[[:space:]]+[1-9][0-9]*$ ]]; then
      break
    fi
    if [[ "$attempt" != "6" ]]; then
      sleep 5
    fi
  done
  if [[ "$target_summary" =~ ^0[[:space:]]+[1-9][0-9]*[[:space:]]+[1-9][0-9]*$ ]]; then
    pass "All Prometheus targets, including LiveKit, are present and healthy."
  else
    fail "Prometheus target verification failed (unhealthy livekit_seen livekit_up): $target_summary"
  fi
else
  fail "Prometheus readiness endpoint is unavailable."
fi

if (( failures > 0 )); then
  log "Readiness failed with $failures issue(s). Review the release output and rollback if a critical journey is affected."
  exit 1
fi

log "Production readiness verification passed."
