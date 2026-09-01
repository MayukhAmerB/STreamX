#!/usr/bin/env bash
set -euo pipefail

BACKEND_URL="${UPTIME_ALERT_BACKEND_URL:-http://127.0.0.1:8000/health/ready}"
BACKEND_HOST_HEADER="${UPTIME_ALERT_BACKEND_HOST_HEADER:-api.alsyedinitiative.com}"
FRONTEND_URL="${UPTIME_ALERT_FRONTEND_URL:-http://127.0.0.1:3000/}"
TIMEOUT_SECONDS="${UPTIME_ALERT_TIMEOUT_SECONDS:-8}"
STATE_FILE="${UPTIME_ALERT_STATE_FILE:-/opt/alsyed/StreamX/.hostinger-state/uptime-alert.state}"
WEBHOOK_URL="${UPTIME_ALERT_WEBHOOK_URL:-}"
REPEAT_EVERY="${UPTIME_ALERT_REPEAT_EVERY:-15}"
CERT_FILES="${UPTIME_ALERT_CERT_FILES:-/etc/letsencrypt/live/alsyedinitiative.com/fullchain.pem,/etc/letsencrypt/live/adlfront.com/fullchain.pem}"
CERT_WARN_DAYS="${UPTIME_ALERT_CERT_WARN_DAYS:-21}"
DISK_USED_WARN_PERCENT="${UPTIME_ALERT_DISK_USED_WARN_PERCENT:-90}"
MEMORY_USED_WARN_PERCENT="${UPTIME_ALERT_MEMORY_USED_WARN_PERCENT:-90}"
CONTAINER_STATE_FILE="${UPTIME_ALERT_CONTAINER_STATE_FILE:-/opt/alsyed/StreamX/.hostinger-state/container-restarts.state}"
PROMETHEUS_URL="${UPTIME_ALERT_PROMETHEUS_URL:-http://127.0.0.1:9090}"
CHECK_PROMETHEUS="${UPTIME_ALERT_CHECK_PROMETHEUS:-1}"

mkdir -p "$(dirname "$STATE_FILE")"
mkdir -p "$(dirname "$CONTAINER_STATE_FILE")"

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

if ! systemctl is-active --quiet nginx; then
  failure_messages+=("nginx service is not active")
elif ! nginx -t >/dev/null 2>&1; then
  failure_messages+=("nginx configuration validation failed")
fi

active_nginx_backups="$(find /etc/nginx/sites-enabled -maxdepth 1 \( -type f -o -type l \) \
  \( -name '*.bak*' -o -name '*~' \) -printf '%f ' 2>/dev/null || true)"
if [[ -n "$active_nginx_backups" ]]; then
  failure_messages+=("backup files are active in sites-enabled: ${active_nginx_backups}")
fi

if command -v openssl >/dev/null 2>&1; then
  IFS=',' read -r -a certificate_files <<<"$CERT_FILES"
  certificate_warning_seconds=$((CERT_WARN_DAYS * 86400))
  for certificate_file in "${certificate_files[@]}"; do
    if [[ ! -f "$certificate_file" ]]; then
      failure_messages+=("TLS certificate file is missing (${certificate_file})")
    elif ! openssl x509 -checkend "$certificate_warning_seconds" -noout -in "$certificate_file" >/dev/null 2>&1; then
      failure_messages+=("TLS certificate expires within ${CERT_WARN_DAYS} days (${certificate_file})")
    fi
  done
else
  failure_messages+=("openssl is unavailable; TLS expiry could not be checked")
fi

disk_used_percent="$(df -P / | awk 'NR == 2 {gsub(/%/, "", $5); print $5}')"
if [[ "$disk_used_percent" =~ ^[0-9]+$ ]] && (( disk_used_percent >= DISK_USED_WARN_PERCENT )); then
  failure_messages+=("root disk usage is ${disk_used_percent}%")
fi

memory_used_percent="$(awk '
  /^MemTotal:/ { total=$2 }
  /^MemAvailable:/ { available=$2 }
  END { if (total > 0) printf "%.0f", ((total-available)/total)*100 }
' /proc/meminfo)"
if [[ "$memory_used_percent" =~ ^[0-9]+$ ]] && (( memory_used_percent >= MEMORY_USED_WARN_PERCENT )); then
  failure_messages+=("memory usage is ${memory_used_percent}%")
fi

if command -v docker >/dev/null 2>&1; then
  unhealthy_containers="$(docker ps --filter health=unhealthy --format '{{.Names}}' | paste -sd, -)"
  if [[ -n "$unhealthy_containers" ]]; then
    failure_messages+=("unhealthy containers: ${unhealthy_containers}")
  fi

  current_container_state="$(mktemp)"
  trap 'rm -f "${current_container_state:-}"' EXIT
  mapfile -t container_ids < <(docker ps -aq)
  if (( ${#container_ids[@]} > 0 )); then
    docker inspect --format '{{.Name}}|{{.RestartCount}}' "${container_ids[@]}" \
      | sed 's#^/##' | sort >"$current_container_state"
  else
    : >"$current_container_state"
  fi

  if [[ -f "$CONTAINER_STATE_FILE" ]]; then
    while IFS='|' read -r container_name restart_count; do
      [[ -n "$container_name" ]] || continue
      previous_restart_count="$(awk -F'|' -v name="$container_name" '$1 == name { print $2; exit }' "$CONTAINER_STATE_FILE")"
      previous_restart_count="${previous_restart_count:-0}"
      if (( restart_count > previous_restart_count )); then
        failure_messages+=("container ${container_name} restarted $((restart_count - previous_restart_count)) time(s) since the last probe")
      fi
    done <"$current_container_state"
  fi
  install -m 0600 "$current_container_state" "$CONTAINER_STATE_FILE"
fi

if [[ "$CHECK_PROMETHEUS" == "1" ]]; then
  prometheus_alerts="$(
    curl -fsS --max-time "$TIMEOUT_SECONDS" "$PROMETHEUS_URL/api/v1/alerts" 2>/dev/null \
      | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
alerts = payload.get("data", {}).get("alerts", [])
names = sorted({
    alert.get("labels", {}).get("alertname", "unknown")
    for alert in alerts
    if alert.get("state") == "firing"
    and alert.get("labels", {}).get("severity") == "critical"
})
print(",".join(names))
' 2>/dev/null
  )" || failure_messages+=("Prometheus alert API is unavailable")
  if [[ -n "${prometheus_alerts:-}" ]]; then
    failure_messages+=("critical Prometheus alerts are firing: ${prometheus_alerts}")
  fi
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
