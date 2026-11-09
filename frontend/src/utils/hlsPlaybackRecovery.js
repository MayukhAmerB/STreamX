// Pure decision logic for the secure live HLS player. Kept free of React,
// DOM and hls.js imports so it can be unit-tested in plain Node.

// Mirror Hls.ErrorTypes values (hls.js 1.x) without importing hls.js here.
export const HLS_NETWORK_ERROR = "networkError";
export const HLS_MEDIA_ERROR = "mediaError";

export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 12_000;
export const MAX_IN_PLACE_NETWORK_ATTEMPTS = 3;
export const PLAYBACK_FREEZE_THRESHOLD_MS = 30_000;
export const PLAYBACK_STARTUP_GRACE_MS = 45_000;
export const LIVE_RESUME_JITTER_MS = 5_000;

export const RECOVERY_ACTIONS = Object.freeze({
  IGNORE: "ignore",
  IN_PLACE_LOAD: "inPlaceLoad",
  RECOVER_MEDIA: "recoverMedia",
  SWAP_CODEC_AND_RECOVER: "swapCodecAndRecover",
  REBUILD: "rebuild",
  RENEW_ACCESS: "renewAccess",
});

export const initialHlsRecoveryState = Object.freeze({
  networkAttempts: 0,
  mediaAttempts: 0,
});

const clampRandom = (random) => {
  const value = Number(typeof random === "function" ? random() : Math.random());
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
};

// Exponential backoff with full random jitter: the delay is drawn uniformly
// from [0.5x, 1.5x] of the exponential base and capped, so an audience that
// hit the same failure at the same moment spreads its reconnects out.
export function jitteredBackoffDelay(
  attempt = 0,
  { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS, random = Math.random } = {}
) {
  const safeAttempt = Math.max(0, Math.min(16, Math.floor(Number(attempt) || 0)));
  const exponentialBase = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  const jittered = exponentialBase * (0.5 + clampRandom(random));
  return Math.round(Math.min(maxMs, Math.max(0, jittered)));
}

// Uniform 0..maxMs delay used when many viewers react to the same broadcast
// state change (for example the stream coming back live).
export function randomJitterDelay(maxMs = LIVE_RESUME_JITTER_MS, random = Math.random) {
  return Math.round(Math.max(0, Number(maxMs) || 0) * clampRandom(random));
}

export function isAuthorizationStatus(httpStatus) {
  const status = Number(httpStatus || 0) || 0;
  return status === 401 || status === 403;
}

// Media element events that only describe ordinary buffering (they also fire
// during startup). hls.js retries its own loads, so these never tear the
// player down.
const BUFFERING_EVENTS = new Set(["waiting", "stalled", "suspend", "progress"]);

export function isBufferingEvent(eventType) {
  return BUFFERING_EVENTS.has(String(eventType || ""));
}

// Media element "error" goes through the same media-recovery ladder as
// hls.js media errors; native HLS playback has no in-place recovery.
export function decideMediaElementEventAction(
  eventType,
  { usingHlsJs = true, state = initialHlsRecoveryState } = {}
) {
  if (String(eventType || "") !== "error") {
    return { action: RECOVERY_ACTIONS.IGNORE, state };
  }
  if (!usingHlsJs) return { action: RECOVERY_ACTIONS.REBUILD, state };
  return decideHlsErrorAction({ fatal: true, type: HLS_MEDIA_ERROR }, state);
}

// Decide how to respond to an hls.js ERROR event. Returns the action plus the
// updated per-player recovery counters; the caller resets the counters once
// playback is healthy again.
export function decideHlsErrorAction(
  { fatal = false, type = "", httpStatus = 0 } = {},
  state = initialHlsRecoveryState
) {
  const current = {
    networkAttempts: Math.max(0, Number(state?.networkAttempts) || 0),
    mediaAttempts: Math.max(0, Number(state?.mediaAttempts) || 0),
  };

  if (!fatal) return { action: RECOVERY_ACTIONS.IGNORE, state: current };
  if (isAuthorizationStatus(httpStatus)) {
    return { action: RECOVERY_ACTIONS.RENEW_ACCESS, state: current };
  }

  if (type === HLS_NETWORK_ERROR) {
    if (current.networkAttempts < MAX_IN_PLACE_NETWORK_ATTEMPTS) {
      return {
        action: RECOVERY_ACTIONS.IN_PLACE_LOAD,
        state: { ...current, networkAttempts: current.networkAttempts + 1 },
      };
    }
    return { action: RECOVERY_ACTIONS.REBUILD, state: current };
  }

  if (type === HLS_MEDIA_ERROR) {
    if (current.mediaAttempts === 0) {
      return { action: RECOVERY_ACTIONS.RECOVER_MEDIA, state: { ...current, mediaAttempts: 1 } };
    }
    if (current.mediaAttempts === 1) {
      return {
        action: RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER,
        state: { ...current, mediaAttempts: 2 },
      };
    }
    return { action: RECOVERY_ACTIONS.REBUILD, state: current };
  }

  // Mux, key-system and other fatal errors cannot be recovered in place.
  return { action: RECOVERY_ACTIONS.REBUILD, state: current };
}

// Watchdog decision for a genuine playback freeze. "resetClock" tells the
// caller to restart its progress timers (paused, hidden or offline viewers
// are never treated as frozen).
export function evaluatePlaybackFreeze({
  now = Date.now(),
  lastProgressAt = now,
  startedAt = now,
  hasPlayedFirstFrame = false,
  paused = false,
  ended = false,
  visible = true,
  online = true,
  consecutiveFreezes = 0,
} = {}) {
  if (paused || ended || !visible || !online) return { action: "resetClock" };

  const escalate = () =>
    (Number(consecutiveFreezes) || 0) > 0
      ? { action: RECOVERY_ACTIONS.REBUILD }
      : { action: RECOVERY_ACTIONS.IN_PLACE_LOAD };

  if (!hasPlayedFirstFrame) {
    // Slow starts are expected (fragment TTFB alone may take 15 s), so only
    // step in when nothing has played for the whole startup grace period.
    return now - startedAt >= PLAYBACK_STARTUP_GRACE_MS ? escalate() : { action: "none" };
  }

  return now - lastProgressAt >= PLAYBACK_FREEZE_THRESHOLD_MS ? escalate() : { action: "none" };
}

export function isAutoplayBlockedError(error) {
  return String(error?.name || "") === "NotAllowedError";
}

export function normalizeStreamStatus(status) {
  return String(status || "").trim().toLowerCase();
}

// True when the broadcast just came back live and this viewer's player is
// not currently playing normally, so an in-place reload is worthwhile.
export function shouldReloadOnStreamLive({ previousStatus = "", nextStatus = "", recovering = false } = {}) {
  const previous = normalizeStreamStatus(previousStatus);
  const next = normalizeStreamStatus(nextStatus);
  return Boolean(recovering && previous && previous !== "live" && next === "live");
}

// The bootstrap fetch only needs to unmount the player when the stream itself
// changed or a reset was requested; a re-signed launch URL for the same HLS
// stream just renews the access cookie in the background.
export function shouldRenewBootstrapInBackground({ previous = null, next = {}, bootstrapReady = false } = {}) {
  if (!bootstrapReady || !previous) return false;
  if (!next.bootstrapUrl || !next.hlsUrl) return false;
  return (
    previous.hlsUrl === next.hlsUrl &&
    previous.refreshKey === next.refreshKey &&
    previous.generation === next.generation &&
    previous.sessionId === next.sessionId
  );
}
