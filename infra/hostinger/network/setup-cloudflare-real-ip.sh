#!/usr/bin/env bash
set -euo pipefail

CONFIG_DIR="${NGINX_REALIP_CONFIG_DIR:-/etc/nginx/conf.d}"
TARGET_FILE="${NGINX_REALIP_TARGET_FILE:-$CONFIG_DIR/10-streamx-cloudflare-realip.conf}"
REAL_IP_HEADER="${REAL_IP_HEADER:-CF-Connecting-IP}"
CLOUDFLARE_IPV4_URL="${CLOUDFLARE_IPV4_URL:-https://www.cloudflare.com/ips-v4}"
CLOUDFLARE_IPV6_URL="${CLOUDFLARE_IPV6_URL:-https://www.cloudflare.com/ips-v6}"

log() {
  printf '[streamx-realip] %s\n' "$*"
}

restore_previous_file() {
  local backup_file="$1"
  if [[ -n "$backup_file" && -f "$backup_file" ]]; then
    cp "$backup_file" "$TARGET_FILE"
  else
    rm -f "$TARGET_FILE"
  fi
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "Missing required command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd nginx
require_cmd systemctl
require_cmd install

install -d "$CONFIG_DIR"

tmp_file="$(mktemp)"
backup_file=""
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

mapfile -t cloudflare_ipv4 < <(curl -fsSL "$CLOUDFLARE_IPV4_URL" | sed '/^\s*$/d')
mapfile -t cloudflare_ipv6 < <(curl -fsSL "$CLOUDFLARE_IPV6_URL" | sed '/^\s*$/d')

if (( ${#cloudflare_ipv4[@]} == 0 && ${#cloudflare_ipv6[@]} == 0 )); then
  log "Cloudflare IP list fetch returned no ranges."
  exit 1
fi

{
  printf '# Managed by StreamX: Cloudflare real client IP restore\n'
  printf '# Re-run this script to refresh trusted proxy ranges.\n'
  printf 'real_ip_header %s;\n' "$REAL_IP_HEADER"
  printf 'real_ip_recursive on;\n'
  printf 'set_real_ip_from 127.0.0.1;\n'
  printf 'set_real_ip_from ::1;\n'
  for cidr in "${cloudflare_ipv4[@]}" "${cloudflare_ipv6[@]}"; do
    printf 'set_real_ip_from %s;\n' "$cidr"
  done
} >"$tmp_file"

if [[ -f "$TARGET_FILE" ]]; then
  backup_file="${TARGET_FILE}.bak.$(date +%F-%H%M%S)"
  cp "$TARGET_FILE" "$backup_file"
fi

install -m 0644 "$tmp_file" "$TARGET_FILE"

if ! nginx -t; then
  restore_previous_file "$backup_file"
  nginx -t >/dev/null 2>&1 || true
  log "nginx validation failed; restored previous real IP config."
  exit 1
fi

systemctl reload nginx
log "Cloudflare real IP config installed at $TARGET_FILE"
if [[ -n "$backup_file" ]]; then
  log "Backup saved to $backup_file"
fi
