#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
EXPECTED_COMMIT="${RELEASE_COMMIT:-}"
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

if "$SCRIPT_DIR/verify-backup.sh" latest; then
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
  unhealthy_targets="unknown"
  for attempt in 1 2 3 4 5 6; do
    unhealthy_targets="$(curl -fsS --max-time 8 http://127.0.0.1:9090/api/v1/targets 2>/dev/null | python3 -c 'import json,sys; data=json.load(sys.stdin); print(sum(1 for target in data["data"]["activeTargets"] if target["health"] != "up"))' 2>/dev/null || printf unknown)"
    if [[ "$unhealthy_targets" == "0" ]]; then
      break
    fi
    if [[ "$attempt" != "6" ]]; then
      sleep 5
    fi
  done
  if [[ "$unhealthy_targets" == "0" ]]; then
    pass "All Prometheus targets are healthy."
  else
    fail "Prometheus has unhealthy targets: $unhealthy_targets"
  fi
else
  fail "Prometheus readiness endpoint is unavailable."
fi

if (( failures > 0 )); then
  log "Readiness failed with $failures issue(s). Review the release output and rollback if a critical journey is affected."
  exit 1
fi

log "Production readiness verification passed."
