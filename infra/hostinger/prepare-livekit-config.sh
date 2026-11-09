#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
LIVEKIT_TEMPLATE_FILE="${LIVEKIT_CONFIG_TEMPLATE:-$REPO_ROOT/infra/hostinger/livekit.yaml}"
EGRESS_TEMPLATE_FILE="${LIVEKIT_EGRESS_CONFIG_TEMPLATE:-$REPO_ROOT/infra/hostinger/egress.yaml}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REVOKED_CREDENTIAL_FINGERPRINTS="ef2ab7a3748e71b428a776396ef839308a644c249c2429a43df18302de4290ed"
if [[ -n "${LIVEKIT_ADDITIONAL_REVOKED_CREDENTIAL_FINGERPRINTS:-}" ]]; then
  REVOKED_CREDENTIAL_FINGERPRINTS+=",${LIVEKIT_ADDITIONAL_REVOKED_CREDENTIAL_FINGERPRINTS}"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  printf '[livekit-config] Production environment file is missing: %s\n' "$ENV_FILE" >&2
  exit 1
fi
for template_file in "$LIVEKIT_TEMPLATE_FILE" "$EGRESS_TEMPLATE_FILE"; do
  if [[ ! -f "$template_file" ]]; then
    printf '[livekit-config] Template is missing: %s\n' "$template_file" >&2
    exit 1
  fi
done

read_env_path() {
  local variable_name="$1"
  local fallback="$2"
  local configured
  configured="$(grep "^${variable_name}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
  configured="${configured%\"}"
  configured="${configured#\"}"
  configured="${configured%\'}"
  configured="${configured#\'}"
  printf '%s\n' "${configured:-$fallback}"
}

LIVEKIT_OUTPUT_FILE="${LIVEKIT_RUNTIME_CONFIG_PATH:-$(read_env_path LIVEKIT_RUNTIME_CONFIG_PATH /etc/streamx/livekit.yaml)}"
EGRESS_OUTPUT_FILE="${LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH:-$(read_env_path LIVEKIT_EGRESS_RUNTIME_CONFIG_PATH /etc/streamx/egress.yaml)}"
for output_file in "$LIVEKIT_OUTPUT_FILE" "$EGRESS_OUTPUT_FILE"; do
  if [[ "$output_file" != /* ]]; then
    printf '[livekit-config] Runtime configuration paths must be absolute.\n' >&2
    exit 1
  fi
done
if [[ "$LIVEKIT_OUTPUT_FILE" == "$EGRESS_OUTPUT_FILE" ]]; then
  printf '[livekit-config] LiveKit and egress runtime configuration paths must differ.\n' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*keys:[[:space:]]*$' "$LIVEKIT_TEMPLATE_FILE"; then
  printf '[livekit-config] Refusing to use a template containing a keys block.\n' >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*(api_key|api_secret):' "$EGRESS_TEMPLATE_FILE"; then
  printf '[livekit-config] Refusing to use an egress template containing API credentials.\n' >&2
  exit 1
fi

for output_dir in "$(dirname -- "$LIVEKIT_OUTPUT_FILE")" "$(dirname -- "$EGRESS_OUTPUT_FILE")"; do
  mkdir -p "$output_dir"
  chmod 0750 "$output_dir"
done

"$PYTHON_BIN" - \
  "$ENV_FILE" \
  "$LIVEKIT_TEMPLATE_FILE" \
  "$EGRESS_TEMPLATE_FILE" \
  "$LIVEKIT_OUTPUT_FILE" \
  "$EGRESS_OUTPUT_FILE" \
  "$REVOKED_CREDENTIAL_FINGERPRINTS" <<'PY'
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

env_path = Path(sys.argv[1])
livekit_template_path = Path(sys.argv[2])
egress_template_path = Path(sys.argv[3])
livekit_output_path = Path(sys.argv[4])
egress_output_path = Path(sys.argv[5])
revoked_fingerprints = {item.strip().lower() for item in sys.argv[6].split(",") if item.strip()}


def parse_env(path):
    values = {}
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def validate_pair(values, key_name, secret_name, required, reject_revoked=False):
    api_key = values.get(key_name, "").strip()
    api_secret = values.get(secret_name, "").strip()
    if not api_key and not api_secret and not required:
        return None
    if not api_key or not api_secret:
        raise SystemExit(f"{key_name} and {secret_name} must be configured together")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", api_key):
        raise SystemExit(f"{key_name} has an invalid format")
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,256}", api_secret):
        raise SystemExit(f"{secret_name} has an invalid format")
    if api_key.lower() in {"devkey", "changeme", "change-me"}:
        raise SystemExit(f"{key_name} contains a development placeholder")
    if api_secret.lower() in {"secret", "changeme", "change-me"}:
        raise SystemExit(f"{secret_name} contains a development placeholder")
    fingerprint = hashlib.sha256(f"{api_key}\0{api_secret}".encode("utf-8")).hexdigest()
    if reject_revoked and fingerprint in revoked_fingerprints:
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET use a revoked credential pair; rotate them before release")
    return api_key, api_secret


values = parse_env(env_path)
credentials = [validate_pair(values, "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", True, reject_revoked=True)]
previous = validate_pair(
    values,
    "LIVEKIT_PREVIOUS_API_KEY",
    "LIVEKIT_PREVIOUS_API_SECRET",
    False,
)
if previous and previous != credentials[0]:
    credentials.append(previous)

livekit_template = livekit_template_path.read_text(encoding="utf-8").rstrip()
livekit_lines = [livekit_template, "", "keys:"]
for api_key, api_secret in credentials:
    livekit_lines.append(f"  {json.dumps(api_key)}: {json.dumps(api_secret)}")
livekit_payload = "\n".join(livekit_lines) + "\n"

egress_template = egress_template_path.read_text(encoding="utf-8").rstrip()
current_api_key, current_api_secret = credentials[0]
egress_payload = "\n".join(
    [
        f"api_key: {json.dumps(current_api_key)}",
        f"api_secret: {json.dumps(current_api_secret)}",
        egress_template,
    ]
) + "\n"

def atomic_write(path, payload, mode, prefix):
    fd, temporary_name = tempfile.mkstemp(prefix=prefix, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


atomic_write(livekit_output_path, livekit_payload, 0o600, ".livekit-")
# The pinned egress image runs as a non-root user whose primary group is root.
atomic_write(egress_output_path, egress_payload, 0o640, ".egress-")
PY

chmod 0600 "$LIVEKIT_OUTPUT_FILE"
chmod 0640 "$EGRESS_OUTPUT_FILE"
printf '[livekit-config] Runtime configurations prepared at %s and %s (credentials not printed).\n' \
  "$LIVEKIT_OUTPUT_FILE" "$EGRESS_OUTPUT_FILE"
