// Meeting rejoin policy (Phase 2, D9/D10).
//
// A meeting student used to give up after ~40 s offline (laptop sleep, network
// switch) and had to tap "Rejoin". Now the room retries without limit while
// the device is online and the tab is visible: quick first attempts, then an
// exponential backoff capped at 30 s with jitter so a whole class does not
// reconnect in lockstep. Only errors a retry cannot fix stop it.
export const MEETING_REJOIN_FIRST_DELAYS_MS = Object.freeze([0, 1500, 4000]);
export const MEETING_REJOIN_BASE_DELAY_MS = 6000;
export const MEETING_REJOIN_MAX_DELAY_MS = 30000;

/** Delay before rejoin attempt `attempt` (0-based). Never ends. */
export function meetingRejoinDelay(attempt, random = Math.random) {
  const index = Math.max(0, Math.floor(Number(attempt) || 0));
  if (index < MEETING_REJOIN_FIRST_DELAYS_MS.length) {
    return MEETING_REJOIN_FIRST_DELAYS_MS[index];
  }
  const exponent = index - MEETING_REJOIN_FIRST_DELAYS_MS.length;
  const ceiling = Math.min(MEETING_REJOIN_MAX_DELAY_MS, MEETING_REJOIN_BASE_DELAY_MS * 2 ** exponent);
  // "Equal jitter": half fixed, half random, so the wait is never ~0.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * True when retrying the join cannot help: the class ended, the student
 * lost access, or this device was signed out elsewhere (the eviction banner
 * takes over). Network errors, 5xx and 429 keep retrying.
 */
export function isTerminalRejoinError(error) {
  const response = error?.response;
  const status = Number(response?.status || 0);
  if (!status) return false;
  const data = response?.data || {};
  const code = String(data?.errors?.code || data?.code || "").toLowerCase();
  const text = `${data?.message || ""} ${data?.errors?.detail || ""}`.toLowerCase();
  if (status === 401) return code === "session_replaced";
  if (status === 403 || status === 404) return true;
  if (status === 400 && (text.includes("ended") || text.includes("no longer active"))) return true;
  if (status === 409 && (text.includes("finished") || text.includes("ended"))) return true;
  return false;
}

/** Retry only while it can work: online and visible. */
export function canRetryMeetingNow(env = {}) {
  const nav = env.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const doc = env.document ?? (typeof document !== "undefined" ? document : undefined);
  if (nav && nav.onLine === false) return false;
  if (doc && doc.visibilityState && doc.visibilityState !== "visible") return false;
  return true;
}
