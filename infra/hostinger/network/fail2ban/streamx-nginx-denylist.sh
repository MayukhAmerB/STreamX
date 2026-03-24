#!/usr/bin/env bash
set -euo pipefail

NGINX_FAIL2BAN_DIR="${NGINX_FAIL2BAN_DIR:-/etc/nginx/streamx-fail2ban}"
NGINX_FAIL2BAN_LIST="${NGINX_FAIL2BAN_LIST:-$NGINX_FAIL2BAN_DIR/ipset.conf}"
NGINX_FAIL2BAN_GEO_CONF="${NGINX_FAIL2BAN_GEO_CONF:-/etc/nginx/conf.d/12-streamx-fail2ban-geo.conf}"
NGINX_FAIL2BAN_SNIPPET="${NGINX_FAIL2BAN_SNIPPET:-/etc/nginx/snippets/streamx_fail2ban_block.conf}"
NGINX_SITE_FILE="${NGINX_SITE_FILE:-/etc/nginx/sites-enabled/alsyedinitiative.conf}"

log() {
  printf '[streamx-nginx-denylist] %s\n' "$*"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "Missing required command: $cmd"
    exit 1
  fi
}

discover_site_file() {
  if [[ -n "${NGINX_SITE_FILE}" && -f "${NGINX_SITE_FILE}" ]]; then
    printf '%s\n' "$NGINX_SITE_FILE"
    return
  fi

  local discovered
  discovered="$(grep -R -lE 'server_name .*((api|livekit|stream)\.alsyedinitiative\.com|(www\.)?alsyedinitiative\.com)' /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d 2>/dev/null | head -n1 || true)"
  if [[ -n "$discovered" ]]; then
    printf '%s\n' "$discovered"
    return
  fi
  return 1
}

validate_ip() {
  local candidate="$1"
  python3 - "$candidate" <<'PY'
import ipaddress
import sys

ipaddress.ip_address(sys.argv[1])
PY
}

write_static_nginx_files() {
  install -d "$NGINX_FAIL2BAN_DIR" /etc/nginx/conf.d /etc/nginx/snippets
  if [[ ! -f "$NGINX_FAIL2BAN_LIST" ]]; then
    install -m 0644 /dev/null "$NGINX_FAIL2BAN_LIST"
  fi
  cat >"$NGINX_FAIL2BAN_GEO_CONF" <<EOF
geo \$streamx_fail2ban_banned {
    default 0;
    include $NGINX_FAIL2BAN_LIST;
}
EOF
  cat >"$NGINX_FAIL2BAN_SNIPPET" <<'EOF'
if ($streamx_fail2ban_banned) {
    return 403;
}
EOF
}

patch_site_file() {
  local site_file="$1"

  python3 - "$site_file" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
include_line = "    include /etc/nginx/snippets/streamx_fail2ban_block.conf;\n"
text = path.read_text()

if "streamx_fail2ban_block.conf" in text:
    print("Fail2ban nginx snippet already present.")
    sys.exit(0)

lines = text.splitlines(keepends=True)
output = []
inside_server = False
brace_depth = 0
inserted_any = False
waiting_for_insert = False

for line in lines:
    stripped = line.strip()
    if stripped.startswith("server {"):
        inside_server = True
        brace_depth = line.count("{") - line.count("}")
        waiting_for_insert = True
        output.append(line)
        continue

    if inside_server:
        brace_depth += line.count("{") - line.count("}")
        output.append(line)
        if waiting_for_insert and stripped.startswith("server_name "):
            output.append(include_line)
            inserted_any = True
            waiting_for_insert = False
        if brace_depth <= 0:
            inside_server = False
            waiting_for_insert = False
        continue

    output.append(line)

if not inserted_any:
    raise SystemExit("No server_name line found to patch with fail2ban snippet.")

path.write_text("".join(output))
print("Patched nginx server blocks with fail2ban snippet.")
PY
}

needs_patch() {
  local site_file="$1"
  if grep -Fq 'streamx_fail2ban_block.conf' "$site_file"; then
    return 1
  fi
  return 0
}

ensure_runtime_ready() {
  local site_file
  site_file="$(discover_site_file)" || {
    log "Could not locate active nginx site file for StreamX."
    exit 1
  }

  if [[ ! -f "$NGINX_FAIL2BAN_LIST" || ! -f "$NGINX_FAIL2BAN_GEO_CONF" || ! -f "$NGINX_FAIL2BAN_SNIPPET" ]]; then
    ensure
    return
  fi

  if needs_patch "$site_file"; then
    ensure
  fi
}

reload_nginx_or_restore() {
  local candidate_file="$1"
  local backup_file="$2"
  if nginx -t; then
    systemctl reload nginx
    return 0
  fi

  cp "$backup_file" "$candidate_file"
  nginx -t >/dev/null 2>&1 || true
  log "nginx validation failed; restored previous state."
  return 1
}

ensure() {
  require_cmd install
  require_cmd nginx
  require_cmd systemctl
  require_cmd python3

  local site_file
  site_file="$(discover_site_file)" || {
    log "Could not locate active nginx site file for StreamX."
    exit 1
  }

  write_static_nginx_files

  if ! needs_patch "$site_file"; then
    if nginx -t; then
      log "nginx denylist already configured using $site_file"
      return 0
    fi
    log "nginx config is invalid before fail2ban patching; refusing to proceed."
    exit 1
  fi

  local site_backup="${site_file}.bak.fail2ban.$(date +%F-%H%M%S)"
  cp "$site_file" "$site_backup"
  patch_site_file "$site_file"

  if nginx -t; then
    systemctl reload nginx
    log "nginx denylist ready using $site_file"
    return 0
  fi

  cp "$site_backup" "$site_file"
  nginx -t >/dev/null 2>&1 || true
  log "Failed to patch nginx site file; restored $site_file"
  exit 1
}

ban_ip() {
  local ip="$1"
  validate_ip "$ip"
  ensure_runtime_ready

  if grep -Fxq "$ip 1;" "$NGINX_FAIL2BAN_LIST"; then
    exit 0
  fi

  local backup_file="${NGINX_FAIL2BAN_LIST}.bak.$(date +%F-%H%M%S)"
  cp "$NGINX_FAIL2BAN_LIST" "$backup_file"
  printf '%s 1;\n' "$ip" >>"$NGINX_FAIL2BAN_LIST"
  sort -u "$NGINX_FAIL2BAN_LIST" -o "$NGINX_FAIL2BAN_LIST"
  reload_nginx_or_restore "$NGINX_FAIL2BAN_LIST" "$backup_file"
}

unban_ip() {
  local ip="$1"
  validate_ip "$ip"
  ensure_runtime_ready

  local backup_file="${NGINX_FAIL2BAN_LIST}.bak.$(date +%F-%H%M%S)"
  cp "$NGINX_FAIL2BAN_LIST" "$backup_file"
  python3 - "$NGINX_FAIL2BAN_LIST" "$ip" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
target = f"{sys.argv[2]} 1;"
lines = [line for line in path.read_text().splitlines() if line.strip() != target]
path.write_text("".join(f"{line}\n" for line in lines))
PY
  reload_nginx_or_restore "$NGINX_FAIL2BAN_LIST" "$backup_file"
}

main() {
  local command="${1:-}"
  case "$command" in
    ensure)
      ensure
      ;;
    ban)
      ban_ip "${2:?IP required}"
      ;;
    unban)
      unban_ip "${2:?IP required}"
      ;;
    *)
      log "Usage: $0 ensure|ban <ip>|unban <ip>"
      exit 1
      ;;
  esac
}

main "$@"
