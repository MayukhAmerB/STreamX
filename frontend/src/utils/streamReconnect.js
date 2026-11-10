// Waits for a live broadcast that went offline mid-class (encoder blip) to
// come back, then asks the player to reattach. Free of React and hls.js so it
// can be driven with fake timers and a fake fetch in tests; the player only
// forwards media events to it.
import {
  PROBE_ACTIONS,
  PROBE_RESULTS,
  classifyPlaylistProbe,
  decideStreamProbeAction,
  parseHlsPlaylist,
  playlistSnapshot,
  randomJitterDelay,
  streamProbeDelay,
} from "./hlsPlaybackRecovery";

export const STREAM_PROBE_TIMEOUT_MS = 8_000;
const VISIBLE_PROBE_JITTER_MS = 1_000;

export const STREAM_RECONNECT_PHASES = Object.freeze({
  // Playing normally.
  IDLE: "idle",
  // The playlist ended but buffered class content is still playing; probing
  // already runs in the background.
  DRAINING: "draining",
  // Everything buffered has been watched; the viewer waits for the stream.
  WAITING: "waiting",
  // The stream is back and the player was asked to reattach.
  RESUMING: "resuming",
});

const defaultIsOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
const defaultIsVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

const resolveUrl = (uri, base) => {
  try {
    return base ? new URL(uri, base).toString() : new URL(uri).toString();
  } catch {
    return "";
  }
};

// Cheap liveness check of the HLS playlist with the same cookie-based access
// as the player (credentials: "include"). A master playlist is resolved to
// its first variant once; later probes only fetch that variant.
export function createLivePlaylistProber({
  url = "",
  fetchImpl = typeof fetch === "function" ? (...args) => fetch(...args) : null,
  baseUrl = typeof window !== "undefined" ? window.location?.href : undefined,
  timeoutMs = STREAM_PROBE_TIMEOUT_MS,
} = {}) {
  let variantUrl = "";

  const fetchPlaylist = async (targetUrl, signal) => {
    const response = await fetchImpl(targetUrl, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
      signal,
    });
    const httpStatus = Number(response?.status || 0) || 0;
    const playlist = response?.ok ? parseHlsPlaylist(await response.text()) : null;
    return { httpStatus, playlist, finalUrl: resolveUrl(response?.url || targetUrl, baseUrl) };
  };

  return async function probe(signal) {
    if (!url || typeof fetchImpl !== "function") {
      return { result: PROBE_RESULTS.UNAVAILABLE, snapshot: null };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener?.("abort", abort, { once: true });
    const timeoutId = setTimeout(abort, timeoutMs);
    try {
      let response = await fetchPlaylist(variantUrl || url, controller.signal);
      if (variantUrl && !response.playlist?.valid) {
        // The variant may be renamed after a restart; read the master next time.
        variantUrl = "";
      }
      if (response.playlist?.valid && response.playlist.isMaster) {
        const nextVariantUrl = response.playlist.variantUris.length
          ? resolveUrl(response.playlist.variantUris[0], response.finalUrl)
          : "";
        if (!nextVariantUrl) return { result: PROBE_RESULTS.UNAVAILABLE, snapshot: null };
        variantUrl = nextVariantUrl;
        response = await fetchPlaylist(variantUrl, controller.signal);
        if (!response.playlist?.valid) variantUrl = "";
      }
      return {
        result: classifyPlaylistProbe(response),
        snapshot: playlistSnapshot(response.playlist),
      };
    } catch {
      return { result: PROBE_RESULTS.UNAVAILABLE, snapshot: null };
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.("abort", abort);
    }
  };
}

// The player persists the probe attempt (initialAttempt / onProbeAttempt) so
// the backoff keeps growing across reattaches when the stream keeps flapping.
export function createStreamReconnectController({
  probe,
  onReattach = () => {},
  onPhaseChange = () => {},
  onProbeAttempt = () => {},
  initialAttempt = 0,
  isOnline = defaultIsOnline,
  isVisible = defaultIsVisible,
  random = Math.random,
  schedule = (callback, delayMs) => setTimeout(callback, delayMs),
  cancel = (timerId) => clearTimeout(timerId),
} = {}) {
  let phase = STREAM_RECONNECT_PHASES.IDLE;
  let timerId = null;
  let inFlight = null;
  let reference = null;
  let confirmCount = 0;
  let streamReturned = false;
  let disposed = false;
  let probeAttempt = Math.max(0, Math.min(100, Math.floor(Number(initialAttempt) || 0)));

  const setPhase = (nextPhase) => {
    if (phase === nextPhase) return;
    phase = nextPhase;
    onPhaseChange(nextPhase);
  };
  const clearTimer = () => {
    if (timerId !== null) {
      cancel(timerId);
      timerId = null;
    }
  };
  const abortProbe = () => {
    if (inFlight) {
      inFlight.abort();
      inFlight = null;
    }
  };
  const isProbing = () =>
    !disposed &&
    !streamReturned &&
    (phase === STREAM_RECONNECT_PHASES.DRAINING || phase === STREAM_RECONNECT_PHASES.WAITING);

  const reattach = () => {
    clearTimer();
    abortProbe();
    setPhase(STREAM_RECONNECT_PHASES.RESUMING);
    onReattach();
  };

  const backoffDelay = () =>
    streamProbeDelay(probeAttempt, { random, hidden: !isVisible() });

  // Offline viewers only keep a slow safety probe (navigator.onLine is not
  // always accurate); handleOnline() probes immediately when the network
  // returns.
  const scheduleProbe = (delayMs) => {
    if (!isProbing() || inFlight) return;
    clearTimer();
    const effectiveDelay = isOnline()
      ? delayMs
      : Math.max(delayMs, streamProbeDelay(Number.POSITIVE_INFINITY, { random }));
    timerId = schedule(() => {
      timerId = null;
      void runProbe();
    }, effectiveDelay);
  };

  const runProbe = async () => {
    if (!isProbing() || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    let outcome;
    try {
      outcome = await probe(controller.signal);
    } catch {
      outcome = { result: PROBE_RESULTS.UNAVAILABLE, snapshot: null };
    }
    if (inFlight !== controller) return;
    inFlight = null;
    if (!isProbing()) return;

    probeAttempt = Math.min(100, probeAttempt + 1);
    onProbeAttempt(probeAttempt);
    const decision = decideStreamProbeAction({
      result: outcome?.result,
      snapshot: outcome?.snapshot || null,
      reference,
    });
    reference = decision.reference;

    if (decision.action === PROBE_ACTIONS.REATTACH) {
      if (phase === STREAM_RECONNECT_PHASES.DRAINING) {
        // Let the viewer finish the buffered class content first.
        streamReturned = true;
        clearTimer();
        return;
      }
      reattach();
      return;
    }
    if (decision.action === PROBE_ACTIONS.CONFIRM) {
      confirmCount += 1;
      scheduleProbe(streamProbeDelay(confirmCount, { random }));
      return;
    }
    confirmCount = 0;
    scheduleProbe(backoffDelay());
  };

  const tailExhausted = () => {
    if (disposed || phase !== STREAM_RECONNECT_PHASES.DRAINING) return;
    if (streamReturned) {
      reattach();
      return;
    }
    setPhase(STREAM_RECONNECT_PHASES.WAITING);
  };

  // Enter (or advance) the outage. Returns true when a new outage started.
  const streamWentOffline = ({ tailExhausted: exhausted = false } = {}) => {
    if (disposed) return false;
    if (phase === STREAM_RECONNECT_PHASES.IDLE) {
      setPhase(exhausted ? STREAM_RECONNECT_PHASES.WAITING : STREAM_RECONNECT_PHASES.DRAINING);
      scheduleProbe(backoffDelay());
      return true;
    }
    if (exhausted) tailExhausted();
    return false;
  };

  const probeSoon = (delayMs = 0) => {
    if (!isProbing() || inFlight) return;
    scheduleProbe(Math.max(0, Number(delayMs) || 0));
  };

  return {
    getPhase: () => phase,
    getProbeAttempt: () => probeAttempt,
    isActive: () => !disposed && phase !== STREAM_RECONNECT_PHASES.IDLE,
    streamWentOffline,
    tailExhausted,
    probeSoon,
    handleOnline: () => probeSoon(0),
    handleOffline: () => {
      if (!isProbing()) return;
      clearTimer();
      abortProbe();
      scheduleProbe(backoffDelay());
    },
    handleVisible: () => {
      if (timerId === null) return;
      probeSoon(randomJitterDelay(VISIBLE_PROBE_JITTER_MS, random));
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      abortProbe();
    },
  };
}
