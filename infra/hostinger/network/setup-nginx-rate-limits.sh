#!/usr/bin/env bash
set -euo pipefail

API_SITE_FILE="${API_SITE_FILE:-/etc/nginx/sites-available/api.alsyedinitiative.com}"
BACKUP_ROOT="${NGINX_RATE_LIMIT_BACKUP_DIR:-/root/nginx-config-backups/streamx-rate-limits}"
RATE_ZONE_FILE="/etc/nginx/conf.d/99-streamx-rate-zones.conf"
RATE_SNIPPET_FILE="/etc/nginx/snippets/streamx_api_rate_limit.conf"
BACKUP_DIR="$BACKUP_ROOT/$(date +%F-%H%M%S)"

install -d /etc/nginx/conf.d
install -d /etc/nginx/snippets
install -d "$BACKUP_DIR"

backup_file() {
  local source="$1"
  local name
  name="$(printf '%s' "$source" | sed 's#^/##; s#/#__#g')"
  if [[ -e "$source" ]]; then
    cp -a "$source" "$BACKUP_DIR/$name"
  else
    touch "$BACKUP_DIR/$name.missing"
  fi
}

restore_file() {
  local target="$1"
  local name
  name="$(printf '%s' "$target" | sed 's#^/##; s#/#__#g')"
  if [[ -f "$BACKUP_DIR/$name.missing" ]]; then
    rm -f "$target"
  else
    cp -a "$BACKUP_DIR/$name" "$target"
  fi
}

backup_file "$RATE_ZONE_FILE"
backup_file "$RATE_SNIPPET_FILE"
backup_file "$API_SITE_FILE"

cat >"$RATE_ZONE_FILE" <<'NGINX'
limit_req_zone $binary_remote_addr zone=streamx_api_per_ip:20m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=streamx_conn_per_ip:20m;
NGINX

cat >"$RATE_SNIPPET_FILE" <<'NGINX'
limit_req zone=streamx_api_per_ip burst=80 nodelay;
limit_conn streamx_conn_per_ip 60;
NGINX

if [[ -f "$API_SITE_FILE" ]]; then
  python3 - "$API_SITE_FILE" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text()
include_line = "        include /etc/nginx/snippets/streamx_api_rate_limit.conf;\n"

# Insert only inside location /api/ { ... } block if missing.
pattern = re.compile(r"(location\s+/api/\s*\{\n)", re.MULTILINE)
match = pattern.search(text)
if not match:
    print("No location /api/ block found, skipped patch.")
    sys.exit(0)

start = match.end()
window = text[start:start+2000]
if "streamx_api_rate_limit.conf" in window:
    print("Rate-limit include already present.")
    sys.exit(0)

text = text[:start] + include_line + text[start:]
path.write_text(text)
print("Patched API server block with rate-limit include.")
PY
fi

if ! nginx -t; then
  restore_file "$RATE_ZONE_FILE"
  restore_file "$RATE_SNIPPET_FILE"
  restore_file "$API_SITE_FILE"
  nginx -t >/dev/null 2>&1 || true
  echo "Nginx validation failed; all rate-limit changes were rolled back."
  exit 1
fi
systemctl reload nginx
echo "Nginx API rate limits applied. Backup: $BACKUP_DIR"
