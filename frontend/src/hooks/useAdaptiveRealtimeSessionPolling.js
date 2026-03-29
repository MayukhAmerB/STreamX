import { useCallback, useEffect, useRef } from "react";
import { getRealtimeSession } from "../api/realtime";
import { apiData } from "../utils/api";

const VISIBLE_RECOVERY_POLL_MS = 6000;
const HIDDEN_RECOVERY_POLL_MS = 30000;
const VISIBLE_LIVE_POLL_MS = 30000;
const HIDDEN_LIVE_POLL_MS = 90000;
const VISIBLE_UNKNOWN_POLL_MS = 15000;
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
  return Math.max(2000, delayMs + jitterOffset);
}

function resolveBasePollDelay({ sessionStatus, streamStatus, visible }) {
  if (sessionStatus === "ended") {
    return 0;
  }
  if (streamStatus && streamStatus !== "live") {
    return visible ? VISIBLE_RECOVERY_POLL_MS : HIDDEN_RECOVERY_POLL_MS;
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
    const baseDelay = resolveBasePollDelay({
      sessionStatus: sessionMetaRef.current.sessionStatus,
      streamStatus: sessionMetaRef.current.streamStatus,
      visible,
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

  return triggerImmediateRefresh;
}
