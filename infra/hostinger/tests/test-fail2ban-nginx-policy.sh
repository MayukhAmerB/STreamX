#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
POLICY_SCRIPT="$SCRIPT_DIR/../network/fail2ban/streamx-nginx-denylist.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/nginx/sites-enabled"
cat >"$TEST_ROOT/bin/nginx" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$TEST_ROOT/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TEST_ROOT/bin/nginx" "$TEST_ROOT/bin/systemctl"

cat >"$TEST_ROOT/nginx/sites-enabled/alsyedinitiative.conf" <<'EOF'
server {
    listen 443 ssl;
    server_name alsyedinitiative.com;
    location / { return 200; }
}
server {
    listen 443 ssl;
    server_name api.alsyedinitiative.com;
    location /api/ { return 200; }
}
EOF

export PATH="$TEST_ROOT/bin:$PATH"
export PYTHON_BIN="${PYTHON_BIN:-python}"
export NGINX_FAIL2BAN_DIR="$TEST_ROOT/nginx/streamx-fail2ban"
export NGINX_FAIL2BAN_LIST="$NGINX_FAIL2BAN_DIR/ipset.conf"
export NGINX_FAIL2BAN_GEO_CONF="$TEST_ROOT/nginx/conf.d/12-streamx-fail2ban-geo.conf"
export NGINX_FAIL2BAN_SNIPPET="$TEST_ROOT/nginx/snippets/streamx_fail2ban_block.conf"
export NGINX_FAIL2BAN_BACKUP_DIR="$NGINX_FAIL2BAN_DIR/backups"
export NGINX_SITE_FILE="$TEST_ROOT/nginx/sites-enabled/alsyedinitiative.conf"

bash "$POLICY_SCRIPT" ensure
bash "$POLICY_SCRIPT" ban 203.0.113.10

grep -Fq '$streamx_fail2ban_block_auth_request' "$NGINX_FAIL2BAN_GEO_CONF"
grep -Fq '/api/auth/(login|password-reset|password-reset-confirm)' "$NGINX_FAIL2BAN_GEO_CONF"
grep -Fq 'return 429;' "$NGINX_FAIL2BAN_SNIPPET"
! grep -Fq 'if ($streamx_fail2ban_banned)' "$NGINX_FAIL2BAN_SNIPPET"
grep -Fq '203.0.113.10 1;' "$NGINX_FAIL2BAN_LIST"
test "$(grep -Fc 'streamx_fail2ban_block.conf' "$NGINX_SITE_FILE")" -eq 2

echo "Fail2ban Nginx policy tests passed."
