#!/usr/bin/env bash
# Label-scoped autoheal with a restart budget (Phase 2 ops).
#
# Restarts containers labelled `streamx.autoheal=true` whose Docker healthcheck
# reports "unhealthy" (Docker itself only restarts on process exit). Each
# container may be restarted at most AUTOHEAL_MAX_RESTARTS times per
# AUTOHEAL_WINDOW_SECONDS; past the budget it is left alone and an alert is
# raised instead, so a crash-looping service cannot flap forever.
#
# Every restart and every exhausted budget is logged (journald via `logger`)
# and passed to AUTOHEAL_ALERT_CMD (e.g. the uptime-alert notifier) when set.
#
# Runs from systemd/streamx-autoheal.timer every 30 s. Never runs during a
# deploy: set AUTOHEAL_PAUSE_FILE (default /run/streamx-autoheal.pause) to pause.
set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"
STATE_DIR="${AUTOHEAL_STATE_DIR:-/var/lib/streamx/autoheal}"
MAX_RESTARTS="${AUTOHEAL_MAX_RESTARTS:-3}"
WINDOW_SECONDS="${AUTOHEAL_WINDOW_SECONDS:-3600}"
LABEL="${AUTOHEAL_LABEL:-streamx.autoheal=true}"
PAUSE_FILE="${AUTOHEAL_PAUSE_FILE:-/run/streamx-autoheal.pause}"
ALERT_CMD="${AUTOHEAL_ALERT_CMD:-}"
NOW="${AUTOHEAL_NOW:-$(date +%s)}"

log() {
  printf '[autoheal] %s\n' "$*"
  if command -v logger >/dev/null 2>&1; then
    logger -t streamx-autoheal -- "$*" 2>/dev/null || true
  fi
}

alert() {
  log "ALERT: $*"
  if [[ -n "$ALERT_CMD" ]]; then
    AUTOHEAL_MESSAGE="$*" bash -c "$ALERT_CMD" || log "alert command failed"
  fi
}

if [[ -e "$PAUSE_FILE" ]]; then
  log "paused ($PAUSE_FILE exists)."
  exit 0
fi

mkdir -p "$STATE_DIR"

unhealthy="$("$DOCKER_BIN" ps --filter "label=$LABEL" --filter "health=unhealthy" --format '{{.ID}} {{.Names}}')"
if [[ -z "$unhealthy" ]]; then
  exit 0
fi

while read -r container_id container_name; do
  [[ -n "${container_id:-}" ]] || continue
  name="${container_name:-$container_id}"
  state_file="$STATE_DIR/${name//[^A-Za-z0-9_.-]/_}"
  touch "$state_file"
  # Keep only restarts inside the window.
  recent="$(awk -v now="$NOW" -v window="$WINDOW_SECONDS" '$1 > now - window' "$state_file")"
  printf '%s\n' "$recent" | sed '/^$/d' > "$state_file"
  count="$(sed '/^$/d' "$state_file" | wc -l | tr -d ' ')"
  if (( count >= MAX_RESTARTS )); then
    alert "$name is unhealthy and its restart budget is used up ($count in ${WINDOW_SECONDS}s); not restarting."
    continue
  fi
  log "restarting unhealthy container $name ($container_id), restart $((count + 1))/$MAX_RESTARTS in window."
  if "$DOCKER_BIN" restart --time 20 "$container_id" >/dev/null; then
    printf '%s\n' "$NOW" >> "$state_file"
    alert "$name was unhealthy and was restarted automatically ($((count + 1))/$MAX_RESTARTS)."
  else
    alert "$name is unhealthy and the restart failed."
  fi
done <<< "$unhealthy"
