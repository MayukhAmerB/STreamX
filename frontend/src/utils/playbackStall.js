// How a live player tells its page that playback stalled, so the page can ask
// the server about the session at once instead of on its 30 s live poll.

export const STALL_REASONS = Object.freeze({
  // The player shows a connection/decoding error; the feed may still be up.
  CONNECTION: "connection",
  // The live playlist answered 404/410 or ended: the feed itself looks gone.
  FEED_LOST: "feed-lost",
});

/** null while playing, otherwise the strongest stall reason the player has. */
export function resolvePlaybackStallReason({ feedLost = false, streamReconnect = null, connectionIssue = null } = {}) {
  if (feedLost || streamReconnect) return STALL_REASONS.FEED_LOST;
  if (connectionIssue) return STALL_REASONS.CONNECTION;
  return null;
}

/** "" when playback is fine, otherwise the stall reason ("stalled" for a bare `true`). */
export function normalizeStallReason(value) {
  if (!value) return "";
  if (typeof value !== "string") return "stalled";
  return value.trim().toLowerCase() || "stalled";
}

export const IDLE_STALL_STATE = Object.freeze({ reason: "", since: 0, polls: 0 });

/**
 * Next stall-tracking state for a new player signal. A stall that starts, or
 * a stronger reason for one already running (a connection error that turns
 * out to be a lost feed), is new evidence: restart the fast-poll window and
 * refresh now. Recovery resets the tracking.
 */
export function advanceStallState(previous, value, now) {
  const reason = normalizeStallReason(value);
  const current = previous || IDLE_STALL_STATE;
  if (reason === current.reason) {
    return { state: current, changed: false, refreshNow: false };
  }
  return {
    state: reason ? { reason, since: now, polls: 0 } : IDLE_STALL_STATE,
    changed: true,
    refreshNow: Boolean(reason),
  };
}
