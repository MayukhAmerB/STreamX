#!/usr/bin/env bash
# Regression: the gateway must re-resolve container names. Without `resolve`,
# nginx keeps the IPs it saw at startup and every request 502s after the
# backends are recreated (this broke payments on api.alsyedinitiative.com).
set -euo pipefail
conf="$(dirname "$0")/../nginx/gateway-lb.conf"
grep -qE '^resolver 127\.0\.0\.11 ' "$conf" || { echo "FAIL: no Docker DNS resolver in $conf"; exit 1; }
bad=$(grep -nE '^\s+server [a-z0-9-]+:[0-9]+' "$conf" | grep -v ' resolve;' || true)
[ -z "$bad" ] || { echo "FAIL: upstream servers without resolve:"; echo "$bad"; exit 1; }
for up in $(grep -oE '^upstream [a-z_]+' "$conf" | awk '{print $2}'); do
  awk -v u="$up" '$0 ~ "^upstream "u" " {f=1} f && /zone /{z=1} f && /^}/{exit} END{exit !z}' "$conf" || { echo "FAIL: upstream $up has no zone"; exit 1; }
done
echo "ok: gateway upstreams re-resolve container names"
