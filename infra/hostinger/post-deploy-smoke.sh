#!/usr/bin/env bash
# Post-deploy smoke gate: proves what users actually load still works.
# Fails (exit 1) when the admin's static assets, API readiness, the protected
# stream gate or the internal-endpoint block regress, when the report virus
# scanner (clamd) does not answer, or when report storage is not noexec.
#
# The first deploy with ClamAV waits (bounded, SMOKE_ANTIVIRUS_WAIT_SECONDS,
# default 600) for freshclam's first signature download and clamd's start.
#
# Optional: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID purge the admin asset
# URLs first, so a previously cached 404 cannot outlive the fix.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
ANTIVIRUS_WAIT_SECONDS="${SMOKE_ANTIVIRUS_WAIT_SECONDS:-600}"
SITE_URL="${SMOKE_SITE_URL:-https://alsyedinitiative.com}"
API_URL="${SMOKE_API_URL:-https://api.alsyedinitiative.com}"
CURL=(curl -sS -m 20 -A "streamx-post-deploy-smoke/1.0")
failures=0
stamp="$(date +%s)"

log() { printf '[post-deploy-smoke] %s\n' "$*"; }
pass() { log "PASS $*"; }
fail() { log "FAIL $*"; failures=$((failures + 1)); }

status_of() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1" || echo 000; }

admin_html="$("${CURL[@]}" "$SITE_URL/admin/login/" || true)"
mapfile -t assets < <(printf '%s' "$admin_html" | grep -oE '(href|src)="/static/[^"]+\.(css|js)"' | sed -E 's/^(href|src)="//; s/"$//' | sort -u)
if [[ "${#assets[@]}" -eq 0 ]]; then
  fail "admin login page lists no static assets"
fi

if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -n "${CLOUDFLARE_ZONE_ID:-}" && "${#assets[@]}" -gt 0 ]]; then
  files_json="$(for asset in "${assets[@]}"; do printf '"%s%s","%s%s",' "$SITE_URL" "$asset" "$API_URL" "$asset"; done)"
  if "${CURL[@]}" -X POST "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      --data "{\"files\":[${files_json%,}]}" | grep -q '"success":true'; then
    log "Purged ${#assets[@]} admin asset URLs from Cloudflare."
  else
    fail "Cloudflare cache purge"
  fi
fi

for asset in "${assets[@]}"; do
  result="$("${CURL[@]}" -o /dev/null -w '%{http_code} %{content_type}' "$SITE_URL$asset?smoke=$stamp" || echo "000 -")"
  case "$result" in
    "200 text/css"*|"200 application/javascript"*|"200 text/javascript"*) pass "$asset" ;;
    *) fail "$asset -> $result" ;;
  esac
done

code="$(status_of "$API_URL/health/ready")"
[[ "$code" == "200" ]] && pass "API readiness" || fail "API readiness -> HTTP $code"

# Without a viewer cookie the stream must be refused (401/403), not missing or erroring.
code="$(status_of "$SITE_URL/hls/stream.m3u8?smoke=$stamp")"
[[ "$code" == "401" || "$code" == "403" ]] && pass "stream authorization gate (HTTP $code)" || fail "stream authorization gate -> HTTP $code"

code="$(status_of "$API_URL/api/internal/ops/resource-profile/")"
[[ "$code" == "404" ]] && pass "internal ops endpoint is not public" || fail "internal ops endpoint exposed -> HTTP $code"

if [[ "${SMOKE_SKIP_CONTAINER_CHECKS:-0}" != "1" ]]; then
  backend_exec=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T backend python manage.py)
  log "Checking the report virus scanner (waits up to ${ANTIVIRUS_WAIT_SECONDS}s on a first deploy)."
  if "${backend_exec[@]}" check_antivirus --wait-seconds "$ANTIVIRUS_WAIT_SECONDS" --interval 15; then
    pass "virus scanner answers PING and reports its signature version"
  else
    fail "virus scanner (clamd) is not answering; report uploads are refused until it does"
  fi
  if "${backend_exec[@]}" check_report_storage --require-noexec; then
    pass "report storage is private and mounted noexec,nosuid,nodev"
  else
    fail "report storage is missing, not writable or not noexec,nosuid,nodev"
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  log "$failures check(s) failed."
  exit 1
fi
log "All checks passed."
