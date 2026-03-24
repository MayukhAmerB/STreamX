#!/usr/bin/env bash
set -euo pipefail

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required. Install from https://k6.io/docs/get-started/installation/" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEST_FILE="${SCRIPT_DIR}/realtime-join.js"

: "${BASE_URL:=http://127.0.0.1:8000}"
: "${SESSION_ID:?Set SESSION_ID}"
: "${DURATION:=3m}"
: "${PREFER_BROADCAST:=0}"

if [[ -z "${AUTH_TOKEN:-}" && -z "${AUTH_TOKENS:-}" && -z "${AUTH_TOKENS_FILE:-}" ]]; then
  echo "Set AUTH_TOKEN, AUTH_TOKENS, or AUTH_TOKENS_FILE." >&2
  exit 1
fi

if [[ -n "${AUTH_TOKENS_FILE:-}" && ! -f "${AUTH_TOKENS_FILE}" ]]; then
  echo "AUTH_TOKENS_FILE does not exist: ${AUTH_TOKENS_FILE}" >&2
  exit 1
fi

for VUS in 50 100 200; do
  echo "[loadtest] Running realtime join test with VUS=${VUS} duration=${DURATION} prefer_broadcast=${PREFER_BROADCAST}"
  BASE_URL="$BASE_URL" SESSION_ID="$SESSION_ID" AUTH_TOKEN="${AUTH_TOKEN:-}" AUTH_TOKENS="${AUTH_TOKENS:-}" AUTH_TOKENS_FILE="${AUTH_TOKENS_FILE:-}" PREFER_BROADCAST="$PREFER_BROADCAST" DEBUG_ERRORS="${DEBUG_ERRORS:-0}" VUS="$VUS" DURATION="$DURATION" \
    k6 run "$TEST_FILE"
done
