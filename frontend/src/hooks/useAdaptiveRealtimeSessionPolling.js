import { useCallback, useEffect, useRef } from "react";
import { getRealtimeSession } from "../api/realtime";
import { apiData } from "../utils/api";
import { IDLE_STALL_STATE, advanceStallState } from "../utils/playbackStall";

const VISIBLE_RECOVERY_POLL_MS = 6000;
const HIDDEN_RECOVERY_POLL_MS = 30000;
const VISIBLE_LIVE_POLL_MS = 30000;
const HIDDEN_LIVE_POLL_MS = 90000;
const VISIBLE_UNKNOWN_POLL_MS = 15000;
// While the viewer's player is stalled (the feed dropped but the server has not
// marked the stream interrupted yet) the page asks the server at once and then
// polls quickly, so "Host reconnecting…" replaces the generic player error
// within seconds instead of waiting out the 30 s live poll.
export const STALLED_FIRST_POLL_MS = 2000;
export const VISIBLE_STALLED_POLL_MS = 3000;
// A stall the server never confirms (still "live" after this long) is the
// viewer's own connection or decoder, not the host: back off towards the live
// pace instead of hammering the API for the rest of the class.
export const STALLED_FAST_WINDOW_MS = 60000;
const HIDDEN_STALLED_POLL_MS = 30000;
const HIDDEN_UNKNOWN_POLL_MS = 60000;
const MAX_FAILURE_BACKOFF_MULTIPLIER = 4;

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function withJitter(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return 0;
  }
  const jitterWindow = Math.min(2000, Math.round(delayMs * 0.15));
  const jitterOffset = Math.round((Math.random() * 2 - 1) * jitterWindow);
  return Math.max(STALLED_FIRST_POLL_MS, delayMs + jitterOffset);
}

/** Visible-tab pace while the player is stalled and the server still says "live". */
export function resolveStalledPollDelay({ stalledPolls = 0, stalledForMs = 0 } = {}) {
  if (stalledForMs < STALLED_FAST_WINDOW_MS) {
    return stalledPolls <= 0 ? STALLED_FIRST_POLL_MS : VISIBLE_STALLED_POLL_MS;
  }
  // 6 s, 12 s, 24 s, then the ordinary live pace.
  const windowsOverdue = Math.floor((stalledForMs - STALLED_FAST_WINDOW_MS) / STALLED_FAST_WINDOW_MS) + 1;
  return Math.min(VISIBLE_LIVE_POLL_MS, VISIBLE_STALLED_POLL_MS * 2 ** windowsOverdue);
}

export function resolveBasePollDelay({
  sessionStatus,
  streamStatus,
  visible,
  playbackStalled = false,
  stalledPolls = 0,
  stalledForMs = 0,
}) {
  if (sessionStatus === "ended") {
    return 0;
  }
  // The server already knows the feed is down: the stall is explained, keep
  // the recovery pace until the stream is back.
  if (streamStatus && streamStatus !== "live") {
    return visible ? VISIBLE_RECOVERY_POLL_MS : HIDDEN_RECOVERY_POLL_MS;
  }
  if (playbackStalled) {
    return visible ? resolveStalledPollDelay({ stalledPolls, stalledForMs }) : HIDDEN_STALLED_POLL_MS;
  }
  if (streamStatus === "live") {
    return visible ? VISIBLE_LIVE_POLL_MS : HIDDEN_LIVE_POLL_MS;
  }
  return visible ? VISIBLE_UNKNOWN_POLL_MS : HIDDEN_UNKNOWN_POLL_MS;
}

export default function useAdaptiveRealtimeSessionPolling({
  sessionId,
  sessionStatus = "",
  streamStatus = "",
  enabled = true,
  playbackStalled = false,
  onSessionData,
}) {
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);
  const inFlightRef = useRef(false);
  const failureCountRef = useRef(0);
  const sessionMetaRef = useRef({
    sessionStatus: normalizeStatus(sessionStatus),
    streamStatus: normalizeStatus(streamStatus),
  });
  const onSessionDataRef = useRef(onSessionData);
  // { reason, since, polls } of the player's current stall (see utils/playbackStall).
  const stallRef = useRef(IDLE_STALL_STATE);

  useEffect(() => {
    onSessionDataRef.current = onSessionData;
  }, [onSessionData]);

  useEffect(() => {
    sessionMetaRef.current = {
      sessionStatus: normalizeStatus(sessionStatus),
      streamStatus: normalizeStatus(streamStatus),
    };
  }, [sessionStatus, streamStatus]);

  const clearScheduledPoll = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refreshNow = useCallback(async () => {
    if (!enabled || !sessionId || cancelledRef.current || inFlightRef.current) {
      return null;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      failureCountRef.current = Math.min(failureCountRef.current + 1, MAX_FAILURE_BACKOFF_MULTIPLIER);
      return null;
    }

    inFlightRef.current = true;
    try {
      const response = await getRealtimeSession(sessionId);
      const latestSession = apiData(response, null);
      if (!latestSession || cancelledRef.current) {
        return latestSession || null;
      }
      failureCountRef.current = 0;
      if (stallRef.current.reason) {
        stallRef.current.polls += 1;
      }
      sessionMetaRef.current = {
        sessionStatus: normalizeStatus(latestSession.status),
        streamStatus: normalizeStatus(latestSession.stream_status),
      };
      if (typeof onSessionDataRef.current === "function") {
        onSessionDataRef.current(latestSession);
      }
      return latestSession;
    } catch {
      failureCountRef.current = Math.min(failureCountRef.current + 1, MAX_FAILURE_BACKOFF_MULTIPLIER);
      return null;
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled, sessionId]);

  const scheduleNextPoll = useCallback(() => {
    clearScheduledPoll();
    if (!enabled || !sessionId || cancelledRef.current) {
      return;
    }

    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    const stall = stallRef.current;
    const baseDelay = resolveBasePollDelay({
      sessionStatus: sessionMetaRef.current.sessionStatus,
      streamStatus: sessionMetaRef.current.streamStatus,
      visible,
      playbackStalled: Boolean(stall.reason),
      stalledPolls: stall.polls,
      stalledForMs: stall.reason ? Date.now() - stall.since : 0,
    });
    if (baseDelay <= 0) {
      return;
    }

    const failureBackoffMultiplier = Math.min(
      MAX_FAILURE_BACKOFF_MULTIPLIER,
      1 + failureCountRef.current
    );
    const nextDelay = withJitter(baseDelay * failureBackoffMultiplier);

    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      await refreshNow();
      if (!cancelledRef.current) {
        scheduleNextPoll();
      }
    }, nextDelay);
  }, [clearScheduledPoll, enabled, refreshNow, sessionId]);

  const triggerImmediateRefresh = useCallback(async () => {
    clearScheduledPoll();
    const result = await refreshNow();
    if (!cancelledRef.current) {
      scheduleNextPoll();
    }
    return result;
  }, [clearScheduledPoll, refreshNow, scheduleNextPoll]);

  useEffect(() => {
    cancelledRef.current = false;
    if (!enabled || !sessionId) {
      clearScheduledPoll();
      return undefined;
    }

    triggerImmediateRefresh();

    const handleVisibleRefresh = () => {
      if (cancelledRef.current) {
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      triggerImmediateRefresh();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleVisibleRefresh();
      } else {
        scheduleNextPoll();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", handleVisibleRefresh);
      window.addEventListener("focus", handleVisibleRefresh);
      window.addEventListener("pageshow", handleVisibleRefresh);
    }

    return () => {
      cancelledRef.current = true;
      clearScheduledPoll();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleVisibleRefresh);
        window.removeEventListener("focus", handleVisibleRefresh);
        window.removeEventListener("pageshow", handleVisibleRefresh);
      }
    };
  }, [clearScheduledPoll, enabled, scheduleNextPoll, sessionId, triggerImmediateRefresh]);

  // The player just stalled, or found new evidence (e.g. a connection error
  // turned into "the feed is gone"): ask the server now and then poll quickly
  // rather than waiting out the 30 s live interval. Recovery returns to the
  // normal pacing.
  useEffect(() => {
    const { state, changed, refreshNow: refreshImmediately } = advanceStallState(
      stallRef.current,
      playbackStalled,
      Date.now()
    );
    if (!changed) {
      return;
    }
    stallRef.current = state;
    if (!enabled || !sessionId) {
      return;
    }
    if (refreshImmediately) {
      triggerImmediateRefresh();
    } else {
      scheduleNextPoll();
    }
  }, [enabled, playbackStalled, scheduleNextPoll, sessionId, triggerImmediateRefresh]);

  return triggerImmediateRefresh;
}
