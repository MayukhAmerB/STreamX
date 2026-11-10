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
// Probing for a broadcast that went offline mid-class (encoder blip).
export const STREAM_PROBE_BASE_MS = 2_000;
export const STREAM_PROBE_MAX_MS = 10_000;
// How long the buffered tail may sit without progress after the playlist
// ended before the viewer is considered to have watched all real content.
export const OFFLINE_TAIL_STALL_MS = 4_000;
// Native HLS cannot see the playlist; after this long without progress the
// player checks whether the stream itself went offline.
export const NATIVE_STALL_PROBE_MS = 10_000;
// Outage telemetry is spread out so a whole audience does not report at once.
export const STREAM_TELEMETRY_JITTER_MS = 10_000;
const OFFLINE_SLATE_EPSILON_S = 0.25;

export const RECOVERY_ACTIONS = Object.freeze({
  IGNORE: "ignore",
  IN_PLACE_LOAD: "inPlaceLoad",
  RECOVER_MEDIA: "recoverMedia",
  SWAP_CODEC_AND_RECOVER: "swapCodecAndRecover",
  REBUILD: "rebuild",
  RENEW_ACCESS: "renewAccess",
  AWAIT_STREAM: "awaitStream",
});

// Signals that the broadcast stopped producing video (as opposed to a
// network or decoding failure on the viewer's side).
export const STREAM_OFFLINE_SIGNALS = Object.freeze({
  MEDIA_ENDED: "mediaEnded",
  PLAYLIST_ENDED: "playlistEnded",
  PLAYLIST_MISSING: "playlistMissing",
  PROBE_OFFLINE: "probeOffline",
});

export const STREAM_INTERRUPTIONS = Object.freeze({
  NONE: "none",
  SESSION_ENDED: "sessionEnded",
  STREAM_OFFLINE: "streamOffline",
});

export const PROBE_RESULTS = Object.freeze({
  LIVE: "live",
  OFFLINE: "offline",
  UNAUTHORIZED: "unauthorized",
  UNAVAILABLE: "unavailable",
});

export const PROBE_ACTIONS = Object.freeze({
  WAIT: "wait",
  CONFIRM: "confirm",
  REATTACH: "reattach",
});

// Mirror Hls.ErrorDetails values (hls.js 1.x) for playlist load failures.
const PLAYLIST_LOAD_ERROR_DETAILS = new Set(["manifestLoadError", "levelLoadError"]);

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
// are never treated as frozen). A live class that reached "ended" means the
// broadcast went offline, so the caller must wait for the stream to return
// rather than give up; while it is already waiting nothing escalates.
export function evaluatePlaybackFreeze({
  now = Date.now(),
  lastProgressAt = now,
  startedAt = now,
  hasPlayedFirstFrame = false,
  paused = false,
  ended = false,
  expectLive = true,
  awaitingStream = false,
  visible = true,
  online = true,
  consecutiveFreezes = 0,
} = {}) {
  if (awaitingStream) return { action: "resetClock" };
  if (ended && expectLive) return { action: RECOVERY_ACTIONS.AWAIT_STREAM };
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

// --- Broadcast went offline mid-class --------------------------------------

// Every broadcast this player shows is live; only a session the backend has
// marked "ended" is allowed to stop.
export function isSessionExpectedLive(sessionStatus) {
  return normalizeStreamStatus(sessionStatus) !== "ended";
}

// Tell a real class end apart from an encoder blip. A signal that the stream
// stopped while the session is still running means "reconnect", never "stop".
export function classifyStreamInterruption({ signal = "", sessionStatus = "" } = {}) {
  if (!Object.values(STREAM_OFFLINE_SIGNALS).includes(signal)) return STREAM_INTERRUPTIONS.NONE;
  return isSessionExpectedLive(sessionStatus)
    ? STREAM_INTERRUPTIONS.STREAM_OFFLINE
    : STREAM_INTERRUPTIONS.SESSION_ENDED;
}

// hls.js level details for a playlist that carries #EXT-X-ENDLIST.
export function isEndedLevelDetails(details) {
  return Boolean(details) && details.live === false;
}

// A missing playlist (Owncast between broadcasts) rather than a broken
// network; segment 404s are left to the normal error ladder.
export function isPlaylistMissingError({ type = "", details = "", httpStatus = 0 } = {}) {
  const status = Number(httpStatus || 0) || 0;
  return (
    type === HLS_NETWORK_ERROR &&
    PLAYLIST_LOAD_ERROR_DETAILS.has(String(details || "")) &&
    (status === 404 || status === 410)
  );
}

const OFFLINE_SLATE_PATTERN = /(^|\/)offline[^/]*\.(ts|m4s|mp4|aac)(\?|#|$)/i;

// Owncast appends a short "offline" clip before #EXT-X-ENDLIST. Returns the
// media time where that clip starts so the player can stop at the end of the
// real class content, or null when the playlist has no such clip.
export function findOfflineSlateStart(fragments = []) {
  if (!Array.isArray(fragments)) return null;
  for (const fragment of fragments) {
    const uri = String(fragment?.relurl || fragment?.url || "");
    const start = Number(fragment?.start);
    if (OFFLINE_SLATE_PATTERN.test(uri) && Number.isFinite(start)) return start;
  }
  return null;
}

// True once the viewer has watched everything that was broadcast before the
// stream went offline: playback ended, reached the offline clip, or the
// remaining buffer ran dry.
export function hasReachedOfflineTail({
  ended = false,
  currentTime = 0,
  slateStart = null,
  msSinceProgress = 0,
  pausedByViewer = false,
} = {}) {
  if (ended) return true;
  const time = Number(currentTime);
  if (slateStart !== null && slateStart !== undefined) {
    const boundary = Number(slateStart);
    if (Number.isFinite(boundary) && Number.isFinite(time) && time >= boundary - OFFLINE_SLATE_EPSILON_S) {
      return true;
    }
  }
  if (pausedByViewer) return false;
  return (Number(msSinceProgress) || 0) >= OFFLINE_TAIL_STALL_MS;
}

// Delay before the next "is the stream back?" probe: exponential from
// STREAM_PROBE_BASE_MS up to STREAM_PROBE_MAX_MS, drawn uniformly from
// [0.5x, 1x] of that ceiling so hundreds of viewers never probe in lock-step
// and the cap is never exceeded. Hidden tabs probe at the slowest tier.
export function streamProbeDelay(
  attempt = 0,
  { baseMs = STREAM_PROBE_BASE_MS, maxMs = STREAM_PROBE_MAX_MS, random = Math.random, hidden = false } = {}
) {
  const safeAttempt = hidden ? 16 : Math.max(0, Math.min(16, Math.floor(Number(attempt) || 0)));
  const ceiling = Math.max(0, Math.min(maxMs, baseMs * 2 ** safeAttempt));
  return Math.round(ceiling * (0.5 + 0.5 * clampRandom(random)));
}

// Minimal M3U8 reader: enough to tell a master playlist from a media playlist,
// whether the media playlist has ended and whether its segments moved on.
export function parseHlsPlaylist(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const playlist = {
    valid: lines[0] === "#EXTM3U",
    isMaster: false,
    variantUris: [],
    endList: false,
    mediaSequence: 0,
    segmentCount: 0,
    lastSegmentUri: "",
  };
  if (!playlist.valid) return playlist;

  let expectVariantUri = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      playlist.isMaster = true;
      expectVariantUri = true;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      playlist.endList = true;
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const sequence = Number.parseInt(line.slice("#EXT-X-MEDIA-SEQUENCE:".length), 10);
      playlist.mediaSequence = Number.isFinite(sequence) ? sequence : 0;
      continue;
    }
    if (line.startsWith("#")) continue;
    if (expectVariantUri) {
      playlist.variantUris.push(line);
      expectVariantUri = false;
      continue;
    }
    if (!playlist.isMaster) {
      playlist.segmentCount += 1;
      playlist.lastSegmentUri = line;
    }
  }
  return playlist;
}

// Classify one probe of the (media) playlist.
export function classifyPlaylistProbe({ httpStatus = 0, playlist = null } = {}) {
  const status = Number(httpStatus || 0) || 0;
  if (isAuthorizationStatus(status)) return PROBE_RESULTS.UNAUTHORIZED;
  if (status === 404 || status === 410) return PROBE_RESULTS.OFFLINE;
  if (status < 200 || status > 299) return PROBE_RESULTS.UNAVAILABLE;
  if (!playlist?.valid || playlist.isMaster) return PROBE_RESULTS.UNAVAILABLE;
  if (playlist.endList || playlist.segmentCount <= 0) return PROBE_RESULTS.OFFLINE;
  return PROBE_RESULTS.LIVE;
}

export function playlistSnapshot(playlist) {
  if (!playlist?.valid || playlist.isMaster) return null;
  return {
    endList: Boolean(playlist.endList),
    mediaSequence: Number(playlist.mediaSequence) || 0,
    segmentCount: Number(playlist.segmentCount) || 0,
    lastSegmentUri: String(playlist.lastSegmentUri || ""),
  };
}

// True when the segment list changed between two probes, i.e. something is
// writing new segments.
export function hasPlaylistAdvanced(previous, current) {
  if (!previous || !current) return false;
  return (
    previous.mediaSequence !== current.mediaSequence ||
    previous.segmentCount !== current.segmentCount ||
    previous.lastSegmentUri !== current.lastSegmentUri
  );
}

// Decide what to do after a probe. A live playlist is only trusted once its
// segments have advanced relative to an earlier probe of this outage, so a
// stale or frozen playlist never pulls the audience into a reattach loop.
// "reference" is the snapshot later probes are compared against.
export function decideStreamProbeAction({ result = "", snapshot = null, reference = null } = {}) {
  if (result === PROBE_RESULTS.UNAUTHORIZED) {
    // The rebuilt player renews access through the normal error ladder.
    return { action: PROBE_ACTIONS.REATTACH, reference };
  }
  if (result === PROBE_RESULTS.LIVE) {
    if (reference && hasPlaylistAdvanced(reference, snapshot)) {
      return { action: PROBE_ACTIONS.REATTACH, reference };
    }
    return { action: PROBE_ACTIONS.CONFIRM, reference: reference || snapshot };
  }
  if (result === PROBE_RESULTS.OFFLINE) {
    return { action: PROBE_ACTIONS.WAIT, reference: snapshot };
  }
  return { action: PROBE_ACTIONS.WAIT, reference };
}

// Telemetry payload for an outage. The backend accepts a fixed set of
// reasons, so outages reuse "upstream" and carry the detail in hls_error_type.
export function buildStreamOutageReport({ kind = "offline", outageMs = 0, attempt = 0 } = {}) {
  const duration = Math.max(0, Math.min(2_147_483_647, Math.round(Number(outageMs) || 0)));
  return {
    reason: "upstream",
    hlsErrorType: kind === "recovered" ? `stream_recovered;outage_ms=${duration}` : "stream_offline",
    httpStatus: 0,
    retryAttempt: Math.max(0, Math.min(100, Math.floor(Number(attempt) || 0))),
  };
}
