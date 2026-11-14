#!/usr/bin/env bash
# Tests for infra/hostinger/deploy-guard.sh (no Docker: the live check is stubbed).
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/../deploy-guard.sh"

expect() {
  local want="$1" now="$2" live_cmd="$3" force="${4:-0}"
  local got=0
  DEPLOY_GUARD_NOW="$now" DEPLOY_GUARD_LIVE_CHECK_CMD="$live_cmd" FORCE="$force" bash "$GUARD" >/dev/null 2>&1 || got=$?
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: now='$now' live='$live_cmd' FORCE=$force: expected exit $want, got $got" >&2
    exit 1
  fi
}

# 2026-11-13 is a Friday, 2026-11-16 a Monday. Times are IST (+05:30).
expect 4 "2026-11-13 19:05 +0530" "exit 0"          # Friday class window
expect 4 "2026-11-15 18:30 +0530" "exit 0"          # Sunday, window start is inclusive
expect 0 "2026-11-15 20:30 +0530" "exit 0"          # window end is exclusive
expect 0 "2026-11-13 18:29 +0530" "exit 0"          # just before the window
expect 0 "2026-11-16 19:05 +0530" "exit 0"          # Monday: no weekly class
expect 3 "2026-11-16 11:00 +0530" "exit 3"          # make-up class live on a Monday
expect 5 "2026-11-16 11:00 +0530" "exit 9"          # the live check itself failed
expect 0 "2026-11-13 19:05 +0530" "exit 0" 1        # FORCE=1 overrides the window
expect 0 "2026-11-16 11:00 +0530" "exit 3" 1        # FORCE=1 overrides a live class
expect 4 "2026-11-13 13:35 +0000" "exit 0"          # 13:35 UTC is 19:05 IST on Friday
echo "deploy-guard tests passed."
