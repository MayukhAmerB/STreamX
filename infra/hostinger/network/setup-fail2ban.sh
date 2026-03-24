#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SSH_PORT="${SSH_PORT:-22}"
WG_SUBNET="${WG_SUBNET:-10.66.66.0/24}"
BOOTSTRAP_UFW="${BOOTSTRAP_UFW:-0}"
INSTALL_CLOUDFLARE_REAL_IP="${INSTALL_CLOUDFLARE_REAL_IP:-1}"
INSTALL_REALIP_REFRESH_TIMER="${INSTALL_REALIP_REFRESH_TIMER:-1}"

FAIL2BAN_DEFAULT_BANTIME="${FAIL2BAN_DEFAULT_BANTIME:-1h}"
FAIL2BAN_DEFAULT_FINDTIME="${FAIL2BAN_DEFAULT_FINDTIME:-10m}"
FAIL2BAN_DEFAULT_MAXRETRY="${FAIL2BAN_DEFAULT_MAXRETRY:-6}"
FAIL2BAN_SSH_BANTIME="${FAIL2BAN_SSH_BANTIME:-4h}"
FAIL2BAN_SSH_MAXRETRY="${FAIL2BAN_SSH_MAXRETRY:-6}"
FAIL2BAN_AUTH_BANTIME="${FAIL2BAN_AUTH_BANTIME:-2h}"
FAIL2BAN_AUTH_MAXRETRY="${FAIL2BAN_AUTH_MAXRETRY:-8}"
FAIL2BAN_PROBE_BANTIME="${FAIL2BAN_PROBE_BANTIME:-24h}"
FAIL2BAN_PROBE_MAXRETRY="${FAIL2BAN_PROBE_MAXRETRY:-6}"
FAIL2BAN_IGNORE_IPS="${FAIL2BAN_IGNORE_IPS:-127.0.0.1/8 ::1 ${WG_SUBNET}}"
NGINX_ACCESS_LOG="${NGINX_ACCESS_LOG:-/var/log/nginx/access.log}"

log() {
  printf '[streamx-fail2ban] %s\n' "$*"
}

is_truthy() {
  local value
  value="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "$value" == "1" || "$value" == "true" || "$value" == "yes" || "$value" == "on" ]]
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "Missing required command: $cmd"
    exit 1
  fi
}

ensure_base_packages() {
  apt-get update -y
  apt-get install -y curl fail2ban ufw
}

ensure_ufw_active() {
  if ! ufw status | grep -q '^Status: active'; then
    if is_truthy "$BOOTSTRAP_UFW"; then
      log "UFW is inactive; applying StreamX firewall baseline first."
      SSH_PORT="$SSH_PORT" WG_SUBNET="$WG_SUBNET" bash "$SCRIPT_DIR/setup-firewall.sh"
    else
      log "UFW is inactive. Run setup-firewall.sh first or re-run with BOOTSTRAP_UFW=1."
      exit 1
    fi
  fi
}

install_cloudflare_real_ip() {
  if ! is_truthy "$INSTALL_CLOUDFLARE_REAL_IP"; then
    log "Skipping Cloudflare real IP config. Only do this if traffic is direct-to-origin."
    return
  fi
  bash "$SCRIPT_DIR/setup-cloudflare-real-ip.sh"
}

install_realip_refresh_timer() {
  if ! is_truthy "$INSTALL_REALIP_REFRESH_TIMER"; then
    log "Skipping Cloudflare real IP refresh timer."
    return
  fi

  install -d /etc/systemd/system
  install -m 0644 \
    "$SCRIPT_DIR/systemd/streamx-cloudflare-realip-refresh.service" \
    /etc/systemd/system/streamx-cloudflare-realip-refresh.service
  install -m 0644 \
    "$SCRIPT_DIR/systemd/streamx-cloudflare-realip-refresh.timer" \
    /etc/systemd/system/streamx-cloudflare-realip-refresh.timer
  systemctl daemon-reload
  systemctl enable --now streamx-cloudflare-realip-refresh.timer
  log "Enabled daily Cloudflare real IP refresh timer."
}

install_filters() {
  install -d /etc/fail2ban/action.d /etc/fail2ban/filter.d /etc/fail2ban/jail.d /usr/local/bin
  install -m 0755 \
    "$SCRIPT_DIR/fail2ban/streamx-nginx-denylist.sh" \
    /usr/local/bin/streamx-nginx-denylist
  install -m 0644 \
    "$SCRIPT_DIR/fail2ban/action.d/streamx-nginx-denylist.conf" \
    /etc/fail2ban/action.d/streamx-nginx-denylist.conf
  install -m 0644 \
    "$SCRIPT_DIR/fail2ban/filter.d/streamx-auth-abuse.conf" \
    /etc/fail2ban/filter.d/streamx-auth-abuse.conf
  install -m 0644 \
    "$SCRIPT_DIR/fail2ban/filter.d/streamx-probe-abuse.conf" \
    /etc/fail2ban/filter.d/streamx-probe-abuse.conf
}

write_streamx_jails() {
  cat >/etc/fail2ban/jail.d/streamx.local <<EOF
[DEFAULT]
banaction = ufw
backend = auto
allowipv6 = auto
usedns = no
bantime = ${FAIL2BAN_DEFAULT_BANTIME}
findtime = ${FAIL2BAN_DEFAULT_FINDTIME}
maxretry = ${FAIL2BAN_DEFAULT_MAXRETRY}
ignoreip = ${FAIL2BAN_IGNORE_IPS}

[sshd]
enabled = true
backend = systemd
port = ${SSH_PORT}
maxretry = ${FAIL2BAN_SSH_MAXRETRY}
bantime = ${FAIL2BAN_SSH_BANTIME}

[streamx-auth-abuse]
enabled = true
banaction = streamx-nginx-denylist
port = http,https
filter = streamx-auth-abuse
logpath = ${NGINX_ACCESS_LOG}
maxretry = ${FAIL2BAN_AUTH_MAXRETRY}
bantime = ${FAIL2BAN_AUTH_BANTIME}

[streamx-probe-abuse]
enabled = true
banaction = streamx-nginx-denylist
port = http,https
filter = streamx-probe-abuse
logpath = ${NGINX_ACCESS_LOG}
maxretry = ${FAIL2BAN_PROBE_MAXRETRY}
bantime = ${FAIL2BAN_PROBE_BANTIME}
EOF
}

validate_local_files() {
  if [[ ! -f "$NGINX_ACCESS_LOG" ]]; then
    log "Warning: nginx access log not found at $NGINX_ACCESS_LOG. Jails were installed but will stay idle until logs exist."
  fi
}

wait_for_fail2ban_socket() {
  local socket_path="/var/run/fail2ban/fail2ban.sock"
  local attempts=20

  for ((i=1; i<=attempts; i++)); do
    if [[ -S "$socket_path" ]]; then
      return 0
    fi
    sleep 1
  done

  log "Fail2ban socket did not appear at $socket_path in time."
  return 1
}

restart_and_verify_fail2ban() {
  systemctl enable --now fail2ban
  fail2ban-client -d >/dev/null
  systemctl restart fail2ban
  wait_for_fail2ban_socket
  fail2ban-client status
  fail2ban-client status sshd >/dev/null
  fail2ban-client status streamx-auth-abuse >/dev/null
  fail2ban-client status streamx-probe-abuse >/dev/null
}

require_cmd bash
require_cmd install
require_cmd systemctl

ensure_base_packages
require_cmd fail2ban-client
ensure_ufw_active
install_cloudflare_real_ip
install_realip_refresh_timer
install_filters
/usr/bin/env bash /usr/local/bin/streamx-nginx-denylist ensure
write_streamx_jails
validate_local_files
restart_and_verify_fail2ban

log "Fail2ban installed safely for StreamX."
log "Active jails: sshd, streamx-auth-abuse, streamx-probe-abuse"
log "Review with: fail2ban-client status"
