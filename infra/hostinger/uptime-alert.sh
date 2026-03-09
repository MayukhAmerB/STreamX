#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="${UPTIME_ALERT_BACKEND_URL:-http://127.0.0.1:8000/health/ready}"
BACKEND_HOST_HEADER="${UPTIME_ALERT_BACKEND_HOST_HEADER:-api.alsyedinitiative.com}"
FRONTEND_URL="${UPTIME_ALERT_FRONTEND_URL:-http://127.0.0.1:3000/}"
TIMEOUT_SECONDS="${UPTIME_ALERT_TIMEOUT_SECONDS:-8}"
STATE_FILE="${UPTIME_ALERT_STATE_FILE:-/opt/alsyed/StreamX/.hostinger-state/uptime-alert.state}"
WEBHOOK_URL="${UPTIME_ALERT_WEBHOOK_URL:-}"
REPEAT_EVERY="${UPTIME_ALERT_REPEAT_EVERY:-15}"

mkdir -p "$(dirname "$STATE_FILE")"

log() {
  printf '[hostinger-uptime] %s\n' "$*"
}

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

send_alert() {
  local message="$1"
  log "$message"
  if [ -z "$WEBHOOK_URL" ]; then
    return 0
  fi
  local payload
  payload="{\"text\":\"$(json_escape "$message")\"}"
  curl -sS --max-time "$TIMEOUT_SECONDS" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$WEBHOOK_URL" >/dev/null || true
}

check_url() {
  local name="$1"
  local url="$2"
  local host_header="${3:-}"
  local extra_headers=()
  if [ -n "$host_header" ]; then
    extra_headers+=(-H "Host: ${host_header}" -H "X-Forwarded-Proto: https")
  fi
  if curl -fsS --max-time "$TIMEOUT_SECONDS" "${extra_headers[@]}" "$url" >/dev/null; then
    return 0
  fi
  return 1
}

failure_messages=()

if ! check_url "backend" "$BACKEND_URL" "$BACKEND_HOST_HEADER"; then
  failure_messages+=("backend readiness probe failed (${BACKEND_URL})")
fi

if ! check_url "frontend" "$FRONTEND_URL"; then
  failure_messages+=("frontend probe failed (${FRONTEND_URL})")
fi

new_status="up"
if [ "${#failure_messages[@]}" -gt 0 ]; then
  new_status="down"
fi

old_status="unknown"
old_count="0"
if [ -f "$STATE_FILE" ]; then
  IFS='|' read -r old_status old_count < "$STATE_FILE" || true
fi

if [ "$new_status" = "up" ]; then
  echo "up|0" > "$STATE_FILE"
  if [ "$old_status" = "down" ]; then
    send_alert "StreamX uptime recovered at $(date -u +%Y-%m-%dT%H:%M:%SZ)."
  fi
  exit 0
fi

new_count=$((old_count + 1))
echo "down|${new_count}" > "$STATE_FILE"

if [ "$old_status" != "down" ] || [ "$((new_count % REPEAT_EVERY))" -eq 0 ]; then
  send_alert "StreamX uptime alert at $(date -u +%Y-%m-%dT%H:%M:%SZ): ${failure_messages[*]}"
fi
