#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
HOST_NGINX_CONFIG="$REPO_ROOT/infra/hostinger/nginx/alsyedinitiative.conf"
GATEWAY_NGINX_CONFIG="$REPO_ROOT/infra/hostinger/nginx/gateway-lb.conf"

host_upstream="$(sed -n '/^upstream backend_app {/,/^}/p' "$HOST_NGINX_CONFIG")"

grep -Fq 'server 127.0.0.1:8088 max_fails=2 fail_timeout=10s;' <<<"$host_upstream"
grep -Fq 'server 127.0.0.1:8000 backup;' <<<"$host_upstream"
! grep -Fxq '    server 127.0.0.1:8000;' <<<"$host_upstream"

grep -Fq 'proxy_next_upstream error timeout http_500 http_502 http_503 http_504;' "$HOST_NGINX_CONFIG"
grep -Fq 'proxy_next_upstream_tries 2;' "$HOST_NGINX_CONFIG"

gateway_health="$(sed -n '/location = \/gateway-healthz {/,/^    }/p' "$GATEWAY_NGINX_CONFIG")"
grep -Fq 'proxy_pass http://streamx_backend_pool/health/live;' <<<"$gateway_health"
grep -Fq 'proxy_set_header Host api.alsyedinitiative.com;' <<<"$gateway_health"
! grep -Fq 'return 200 "ok\n";' <<<"$gateway_health"

echo "Gateway routing configuration tests passed."
