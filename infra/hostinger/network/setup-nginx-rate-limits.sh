#!/usr/bin/env bash
set -euo pipefail

API_SITE_FILE="${API_SITE_FILE:-/etc/nginx/sites-available/api.alsyedinitiative.com}"

install -d /etc/nginx/conf.d
install -d /etc/nginx/snippets

cat >/etc/nginx/conf.d/99-streamx-rate-zones.conf <<'NGINX'
limit_req_zone $binary_remote_addr zone=streamx_api_per_ip:20m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=streamx_conn_per_ip:20m;
NGINX

cat >/etc/nginx/snippets/streamx_api_rate_limit.conf <<'NGINX'
limit_req zone=streamx_api_per_ip burst=80 nodelay;
limit_conn streamx_conn_per_ip 60;
NGINX

if [[ -f "$API_SITE_FILE" ]]; then
  cp "$API_SITE_FILE" "${API_SITE_FILE}.bak.$(date +%F-%H%M%S)"
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

nginx -t
systemctl reload nginx
echo "Nginx API rate limits applied."
