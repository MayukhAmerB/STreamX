#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREPARE_SCRIPT="$SCRIPT_DIR/../prepare-livekit-config.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

cat >"$TEST_ROOT/livekit-template.yaml" <<'EOF'
port: 7880
prometheus_port: 6789
redis:
  address: redis:6379
EOF
cat >"$TEST_ROOT/egress-template.yaml" <<'EOF'
ws_url: ws://127.0.0.1:7880
redis:
  address: redis:6379
EOF
cat >"$TEST_ROOT/production.env" <<EOF
LIVEKIT_API_KEY=production_key_123
LIVEKIT_API_SECRET=production_secret_12345678901234567890
LIVEKIT_PREVIOUS_API_KEY=previous_key_123
LIVEKIT_PREVIOUS_API_SECRET=previous_secret_12345678901234567890
LIVEKIT_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/livekit.yaml
LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/egress.yaml
EOF

HOSTINGER_ENV_FILE="$TEST_ROOT/production.env" \
LIVEKIT_CONFIG_TEMPLATE="$TEST_ROOT/livekit-template.yaml" \
LIVEKIT_EGRESS_CONFIG_TEMPLATE="$TEST_ROOT/egress-template.yaml" \
PYTHON_BIN="${PYTHON_BIN:-python}" \
  bash "$PREPARE_SCRIPT"

runtime_config="$TEST_ROOT/runtime/livekit.yaml"
egress_runtime_config="$TEST_ROOT/runtime/egress.yaml"
test -f "$runtime_config"
test -f "$egress_runtime_config"
if [[ "$(uname -s)" != MINGW* ]]; then
  test "$(stat -c %a "$runtime_config")" = "600"
  test "$(stat -c %a "$egress_runtime_config")" = "640"
fi
grep -Fqx 'keys:' "$runtime_config"
grep -Fq '"production_key_123": "production_secret_12345678901234567890"' "$runtime_config"
grep -Fq '"previous_key_123": "previous_secret_12345678901234567890"' "$runtime_config"
grep -Fq 'api_key: "production_key_123"' "$egress_runtime_config"
grep -Fq 'api_secret: "production_secret_12345678901234567890"' "$egress_runtime_config"
! grep -Fq 'keys:' "$TEST_ROOT/livekit-template.yaml"
! grep -Eq '^[[:space:]]*(api_key|api_secret):' "$TEST_ROOT/egress-template.yaml"

cat >"$TEST_ROOT/invalid.env" <<EOF
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/invalid.yaml
LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/invalid-egress.yaml
EOF
if HOSTINGER_ENV_FILE="$TEST_ROOT/invalid.env" \
LIVEKIT_CONFIG_TEMPLATE="$TEST_ROOT/livekit-template.yaml" \
LIVEKIT_EGRESS_CONFIG_TEMPLATE="$TEST_ROOT/egress-template.yaml" \
PYTHON_BIN="${PYTHON_BIN:-python}" \
  bash "$PREPARE_SCRIPT"; then
  echo "Expected placeholder credentials to be rejected." >&2
  exit 1
fi

cat >"$TEST_ROOT/revoked.env" <<EOF
LIVEKIT_API_KEY=revoked_key_123
LIVEKIT_API_SECRET=revoked_secret_12345678901234567890
LIVEKIT_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/revoked.yaml
LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH=$TEST_ROOT/runtime/revoked-egress.yaml
EOF
revoked_fingerprint="$(${PYTHON_BIN:-python} - <<'PY'
import hashlib
print(hashlib.sha256(b"revoked_key_123\0revoked_secret_12345678901234567890").hexdigest())
PY
)"
if HOSTINGER_ENV_FILE="$TEST_ROOT/revoked.env" \
  LIVEKIT_CONFIG_TEMPLATE="$TEST_ROOT/livekit-template.yaml" \
  LIVEKIT_EGRESS_CONFIG_TEMPLATE="$TEST_ROOT/egress-template.yaml" \
  LIVEKIT_ADDITIONAL_REVOKED_CREDENTIAL_FINGERPRINTS="$revoked_fingerprint" \
  PYTHON_BIN="${PYTHON_BIN:-python}" \
  bash "$PREPARE_SCRIPT"; then
  echo "Expected revoked credentials to be rejected." >&2
  exit 1
fi

echo "LiveKit runtime configuration tests passed."
