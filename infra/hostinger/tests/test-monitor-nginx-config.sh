#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../nginx/monitor-subdomain.conf"

require_line() {
  local expected="$1"
  if ! grep -Fqx "$expected" "$CONFIG_FILE"; then
    echo "Missing expected monitor Nginx directive: $expected" >&2
    exit 1
  fi
}

require_line '    server_name monitor.alsyedinitiative.com;'
require_line '    server 127.0.0.1:3001;'
require_line '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;'
require_line '    add_header X-Content-Type-Options "nosniff" always;'
require_line '    add_header X-Frame-Options "SAMEORIGIN" always;'
require_line '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;'
require_line '    add_header Content-Security-Policy "frame-ancestors '\''self'\''; object-src '\''none'\''; base-uri '\''self'\''" always;'
require_line '    add_header X-Robots-Tag "noindex, nofollow, noarchive" always;'
require_line '        proxy_set_header Upgrade $http_upgrade;'
require_line '        proxy_set_header Connection "upgrade";'

echo "Monitor Nginx security header configuration is complete."
