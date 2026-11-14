#!/usr/bin/env bash
# Tests for infra/hostinger/autoheal.sh with a stubbed docker CLI.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
AUTOHEAL="$SCRIPT_DIR/../autoheal.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  ps) printf '%s\n' "${STUB_UNHEALTHY:-}" ;;
  restart) echo "$@" >> "$STUB_LOG" ;;
esac
STUB
chmod +x "$WORK/docker"

run() {
  DOCKER_BIN="$WORK/docker" AUTOHEAL_STATE_DIR="$WORK/state" AUTOHEAL_PAUSE_FILE="$WORK/pause" \
    AUTOHEAL_MAX_RESTARTS=2 AUTOHEAL_WINDOW_SECONDS=3600 AUTOHEAL_ALERT_CMD='echo "$AUTOHEAL_MESSAGE" >> '"$WORK/alerts" \
    STUB_LOG="$WORK/restarts" "$@" bash "$AUTOHEAL" >/dev/null
}

# Nothing unhealthy: nothing restarted.
STUB_UNHEALTHY="" run env
[[ ! -s "$WORK/restarts" ]] || { echo "FAIL: restarted with nothing unhealthy" >&2; exit 1; }

# Two restarts inside the budget, the third is refused and alerted.
STUB_UNHEALTHY="abc123 streamx-worker-1" AUTOHEAL_NOW=1000 run env
STUB_UNHEALTHY="abc123 streamx-worker-1" AUTOHEAL_NOW=1100 run env
STUB_UNHEALTHY="abc123 streamx-worker-1" AUTOHEAL_NOW=1200 run env
[[ "$(wc -l < "$WORK/restarts" | tr -d ' ')" == "2" ]] || { echo "FAIL: expected 2 restarts" >&2; cat "$WORK/restarts" >&2; exit 1; }
grep -q "restart budget is used up" "$WORK/alerts" || { echo "FAIL: no budget alert" >&2; exit 1; }

# The window slides: an hour later it may restart again.
STUB_UNHEALTHY="abc123 streamx-worker-1" AUTOHEAL_NOW=5000 run env
[[ "$(wc -l < "$WORK/restarts" | tr -d ' ')" == "3" ]] || { echo "FAIL: window did not slide" >&2; exit 1; }

# Paused during a deploy.
touch "$WORK/pause"
STUB_UNHEALTHY="def456 streamx-worker-2-1" AUTOHEAL_NOW=9000 run env
grep -q "def456" "$WORK/restarts" && { echo "FAIL: restarted while paused" >&2; exit 1; }

echo "autoheal tests passed."
