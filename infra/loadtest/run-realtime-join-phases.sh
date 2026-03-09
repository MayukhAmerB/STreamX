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
: "${AUTH_TOKEN:?Set AUTH_TOKEN}"
: "${DURATION:=3m}"

for VUS in 50 100 200; do
  echo "[loadtest] Running realtime join test with VUS=${VUS} duration=${DURATION}"
  BASE_URL="$BASE_URL" SESSION_ID="$SESSION_ID" AUTH_TOKEN="$AUTH_TOKEN" VUS="$VUS" DURATION="$DURATION" \
    k6 run "$TEST_FILE"
done
