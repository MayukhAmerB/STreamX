#!/usr/bin/env bash
# Deploy guard (Phase 2): refuse a deploy that would interrupt a live class.
#
#   infra/hostinger/deploy-guard.sh            # exit 0 = safe, non-zero = refuse
#   FORCE=1 infra/hostinger/deploy-guard.sh    # report, but never block
#
# Refuses when:
#   * it is inside the weekly class window, Fri-Sun 18:30-20:30 IST
#     (checked here, without Docker, so it works even if the backend is down);
#   * a class is live right now: `manage.py live_deploy_guard` inside the
#     running backend container (a session streaming, a fresh Host Studio
#     heartbeat, or a feed seen in the last 10 minutes).
#
# Call it first in a release (release-production.sh / deploy-safe.sh) or by
# hand. Exit codes: 0 safe, 3 class live, 4 class window, 5 guard error.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${HOSTINGER_ENV_FILE:-$REPO_ROOT/backend/.env.hostinger.production}"
COMPOSE_FILE="${HOSTINGER_COMPOSE_FILE:-$REPO_ROOT/docker-compose.hostinger.yml}"
FORCE="${FORCE:-0}"
# Test hooks: a fixed "now" (any `date -d` string) and a stub for the live check.
GUARD_NOW="${DEPLOY_GUARD_NOW:-now}"
LIVE_CHECK_CMD="${DEPLOY_GUARD_LIVE_CHECK_CMD:-}"

log() {
  printf '[deploy-guard] %s\n' "$*" >&2
}

if [[ "$FORCE" != "0" && "$FORCE" != "1" ]]; then
  log "FORCE must be 0 or 1."
  exit 5
fi

refuse() {
  local code="$1"
  shift
  if [[ "$FORCE" == "1" ]]; then
    log "WARNING: $* -- continuing because FORCE=1."
    exit 0
  fi
  log "REFUSED: $*"
  log "Deploy outside class time, or rerun with FORCE=1 if this is an emergency."
  exit "$code"
}

# 1. Weekly class window in IST (1=Mon .. 7=Sun; Fri=5, Sat=6, Sun=7). A POSIX
#    TZ string, so it works without zoneinfo (IST has no DST).
IST_TZ="IST-5:30"
weekday="$(TZ="$IST_TZ" date -d "$GUARD_NOW" +%u)"
hhmm="$(TZ="$IST_TZ" date -d "$GUARD_NOW" +%H%M)"
hhmm=$((10#$hhmm))
if [[ "$weekday" -ge 5 ]] && (( hhmm >= 1830 && hhmm < 2030 )); then
  refuse 4 "inside the live-class window (Fri-Sun 18:30-20:30 IST; now $(TZ="$IST_TZ" date -d "$GUARD_NOW" '+%a %H:%M') IST)."
fi

# 2. A class live right now (any day, any time: make-up classes count too).
run_live_check() {
  if [[ -n "$LIVE_CHECK_CMD" ]]; then
    bash -c "$LIVE_CHECK_CMD"
    return
  fi
  local container
  container="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q backend 2>/dev/null || true)"
  if [[ -z "$container" ]]; then
    log "Backend container is not running; cannot check for live classes (window check passed)."
    return 0
  fi
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T backend \
    python manage.py live_deploy_guard --skip-window
}

set +e
live_output="$(run_live_check 2>&1)"
live_status=$?
set -e
if [[ -n "$live_output" ]]; then
  printf '%s\n' "$live_output" >&2
fi
case "$live_status" in
  0) ;;
  3) refuse 3 "a class is live right now." ;;
  *)
    if [[ "$FORCE" == "1" ]]; then
      log "WARNING: live-class check failed (exit $live_status) -- continuing because FORCE=1."
      exit 0
    fi
    log "Live-class check failed (exit $live_status). Fix it, or rerun with FORCE=1."
    exit 5
    ;;
esac

log "Safe to deploy: no live class and outside the class window."
