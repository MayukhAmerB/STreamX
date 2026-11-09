#!/usr/bin/env bash
# Post-deploy smoke gate: proves what users actually load still works.
# Fails (exit 1) when the admin's static assets, API readiness, the protected
# stream gate or the internal-endpoint block regress.
#
# Optional: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID purge the admin asset
# URLs first, so a previously cached 404 cannot outlive the fix.
set -euo pipefail

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

if [[ "$failures" -gt 0 ]]; then
  log "$failures check(s) failed."
  exit 1
fi
log "All checks passed."
