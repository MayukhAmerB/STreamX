import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { reportRealtimeBroadcastPlaybackIssue } from "../../api/realtime";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";
import {
  NATIVE_STALL_PROBE_MS,
  PROBE_RESULTS,
  RECOVERY_ACTIONS,
  STREAM_INTERRUPTIONS,
  STREAM_OFFLINE_SIGNALS,
  STREAM_TELEMETRY_JITTER_MS,
  buildStreamOutageReport,
  classifyStreamInterruption,
  decideHlsErrorAction,
  decideMediaElementEventAction,
  evaluatePlaybackFreeze,
  findOfflineSlateStart,
  hasReachedOfflineTail,
  initialHlsRecoveryState,
  isAutoplayBlockedError,
  isEndedLevelDetails,
  isPlaylistMissingError,
  isSessionExpectedLive,
  jitteredBackoffDelay,
  normalizeStreamStatus,
  randomJitterDelay,
  shouldReloadOnStreamLive,
  shouldRenewBootstrapInBackground,
} from "../../utils/hlsPlaybackRecovery";
import {
  STREAM_RECONNECT_PHASES,
  createLivePlaylistProber,
  createStreamReconnectController,
} from "../../utils/streamReconnect";

const PLAYBACK_WATCHDOG_INTERVAL_MS = 5_000;
const PLAYBACK_REPORT_DEDUP_MS = 30_000;
// A media element error and the matching hls.js media error usually arrive
// together; count them as one failure.
const MEDIA_ERROR_DEDUP_MS = 1_000;
const RECONNECT_JITTER_MS = 2_000;
const HEALTHY_PLAYBACK_CONFIRM_MS = 10_000;

const retryPolicy = (maxNumRetry) => ({
  maxNumRetry,
  retryDelayMs: 500,
  maxRetryDelayMs: 8_000,
  backoff: "exponential",
});

function PlayerMessage({ children, onRetry = null }) {
  return (
    <div className="relative z-10 flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[#BBBBBB]">
      <span>{children}</span>
      {typeof onRetry === "function" ? (
        <button
          type="button"
          data-playback-gesture-ignore="true"
          onClick={onRetry}
          className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/20"
        >
          Retry now
        </button>
      ) : null}
    </div>
  );
}

function getPlaybackIssue({ errorType = "", httpStatus = 0, offline = false } = {}) {
  const normalizedErrorType = String(errorType || "").trim();
  const normalizedStatus = Number(httpStatus || 0) || 0;

  if (offline) {
    return {
      reason: "network",
      hlsErrorType: normalizedErrorType,
      httpStatus: normalizedStatus,
      message: "Connection error: your internet connection was lost. Reconnecting when it returns...",
    };
  }
  if (normalizedStatus === 401 || normalizedStatus === 403) {
    return {
      reason: "authorization",
      hlsErrorType: normalizedErrorType,
      httpStatus: normalizedStatus,
      message: "Connection error: your secure viewing session was interrupted. Reconnecting automatically...",
    };
  }
  if (normalizedStatus >= 500) {
    return {
      reason: "upstream",
      hlsErrorType: normalizedErrorType,
      httpStatus: normalizedStatus,
      message: "Connection error: the streaming service is temporarily unavailable. Reconnecting automatically...",
    };
  }
  if (normalizedErrorType === Hls.ErrorTypes.MEDIA_ERROR) {
    return {
      reason: "media",
      hlsErrorType: normalizedErrorType,
      httpStatus: normalizedStatus,
      message: "Connection error: video playback was interrupted. Reconnecting automatically...",
    };
  }
  return {
    reason: "network",
    hlsErrorType: normalizedErrorType,
    httpStatus: normalizedStatus,
    message: "Connection error: the video connection was interrupted. Checking the connection and reconnecting...",
  };
}

function reportPlaybackIssue({ sessionId, issue, retryAttempt, lastReportedIssueRef }) {
  if (!sessionId || !issue?.reason) return;
  const key = `${issue.reason}:${issue.hlsErrorType}:${issue.httpStatus || 0}`;
  const now = Date.now();
  if (
    lastReportedIssueRef.current.key === key &&
    now - lastReportedIssueRef.current.reportedAt < PLAYBACK_REPORT_DEDUP_MS
  ) {
    return;
  }
  lastReportedIssueRef.current = { key, reportedAt: now };
  void reportRealtimeBroadcastPlaybackIssue(sessionId, {
    reason: issue.reason,
    hls_error_type: issue.hlsErrorType,
    http_status: issue.httpStatus || 0,
    retry_attempt: retryAttempt,
  }).catch(() => {});
}

// Every viewer sees the same outage at the same moment, so outage telemetry is
// sent after a random delay instead of all at once.
function queueStreamOutageReport({ sessionId, report, timers, lastReportedIssueRef }) {
  if (!sessionId || !report) return;
  const timerId = window.setTimeout(() => {
    timers.delete(timerId);
    reportPlaybackIssue({
      sessionId,
      issue: report,
      retryAttempt: report.retryAttempt,
      lastReportedIssueRef,
    });
  }, randomJitterDelay(STREAM_TELEMETRY_JITTER_MS));
  timers.add(timerId);
}

function StreamReconnectOverlay({ offline = false, hadPlayback = true, onRetry }) {
  const headline = offline
    ? "Waiting for your internet connection..."
    : hadPlayback
      ? "Reconnecting to class..."
      : "Waiting for the live video to start...";
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-[#161616]/90 px-6 text-center"
    >
      <span
        aria-hidden="true"
        className="h-8 w-8 animate-spin rounded-full border-2 border-[#525252] border-t-[#F4F4F4] motion-reduce:animate-none"
      />
      <span className="text-sm font-medium text-[#F4F4F4]">{headline}</span>
      <span className="text-xs text-[#C6C6C6]">The video will resume here automatically.</span>
      <button
        type="button"
        data-playback-gesture-ignore="true"
        onClick={onRetry}
        className="text-xs font-semibold text-[#C6C6C6] underline decoration-[#C6C6C6]/50 underline-offset-2 transition hover:text-[#F4F4F4] hover:decoration-[#F4F4F4]"
      >
        Retry now
      </button>
    </div>
  );
}

export default function SecureHlsBroadcastPlayer({
  sessionId = null,
  bootstrapUrl = "",
  hlsUrl = "",
  fallbackEmbedUrl = "",
  refreshKey = 0,
  streamStatus = "",
  sessionStatus = "",
  title = "Broadcast Stream",
}) {
  const videoRef = useRef(null);
  const playerRetryTimerRef = useRef(null);
  const recoveryAttemptRef = useRef(0);
  const lastReportedIssueRef = useRef({ key: "", reportedAt: 0 });
  const bootstrapReadyRef = useRef(false);
  const bootstrapIdentityRef = useRef(null);
  const playbackHealthyRef = useRef(false);
  const recoveringRef = useRef(false);
  const liveResumeRef = useRef(null);
  const previousStreamStatusRef = useRef(normalizeStreamStatus(streamStatus));
  // Outage of the broadcast itself ({ startedAt, probeAttempt }); survives the
  // player rebuild that reattaches to the returned stream.
  const streamOutageRef = useRef(null);
  const reconnectControllerRef = useRef(null);
  const sessionStatusRef = useRef(sessionStatus);
  const hasEverPlayedRef = useRef(false);
  const outageReportTimersRef = useRef(new Set());
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");
  const [connectionIssue, setConnectionIssue] = useState(null);
  const [bootstrapGeneration, setBootstrapGeneration] = useState(0);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [unsupportedBrowser, setUnsupportedBrowser] = useState(false);
  // "" while playback is normal, "muted" after autoplay only succeeded muted,
  // "blocked" when the browser requires a click before any playback.
  const [autoplayState, setAutoplayState] = useState("");
  // null while the broadcast is up; { offline, hadPlayback } while waiting for
  // it to come back.
  const [streamReconnect, setStreamReconnect] = useState(null);
  const normalizedStreamStatus = normalizeStreamStatus(streamStatus);
  const sessionExpectedLive = isSessionExpectedLive(sessionStatus);

  const retryNow = () => {
    setConnectionIssue({ message: "Retrying the secure video connection..." });
    setBootstrapGeneration((current) => current + 1);
  };

  const unmuteVideo = () => {
    const video = videoRef.current;
    setAutoplayState("");
    if (!video) return;
    video.muted = false;
    if (video.paused) void video.play().catch(() => {});
  };

  const startVideoFromGesture = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    void video
      .play()
      .then(() => setAutoplayState(""))
      .catch(() => {
        // Keep the prompt visible; the next click is another user gesture.
      });
  };

  useEffect(() => {
    let cancelled = false;
    let bootstrapRetryTimer = null;

    const setBootstrapReadyState = (ready) => {
      bootstrapReadyRef.current = ready;
      setBootstrapReady(ready);
    };
    const previousIdentity = bootstrapIdentityRef.current;
    const identity = {
      bootstrapUrl,
      hlsUrl,
      refreshKey,
      generation: bootstrapGeneration,
      sessionId,
    };
    // A re-signed launch URL for the same stream only renews the access
    // cookie; the mounted player keeps playing while that happens.
    const renewInBackground = shouldRenewBootstrapInBackground({
      previous: previousIdentity,
      next: identity,
      bootstrapReady: bootstrapReadyRef.current,
    });
    bootstrapIdentityRef.current = identity;

    if (!renewInBackground) {
      setBootstrapReadyState(false);
      setBootstrapError("");
      setUnsupportedBrowser(false);
      setPlayerGeneration(0);
      // Access renewals keep their backoff so a persistent 401/403 does not
      // loop at the minimum delay; a new stream or manual refresh starts over.
      const sameStream =
        previousIdentity?.hlsUrl === hlsUrl &&
        previousIdentity?.refreshKey === refreshKey &&
        previousIdentity?.sessionId === sessionId;
      if (!sameStream) recoveryAttemptRef.current = 0;
    }

    if (!bootstrapUrl || !hlsUrl) {
      setBootstrapError("Secure stream details are unavailable.");
      return () => {
        cancelled = true;
      };
    }

    const preparePlayback = async (attempt = 0) => {
      try {
        const response = await fetch(bootstrapUrl, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          redirect: "follow",
        });
        if (!response.ok) {
          const error = new Error(`Secure stream bootstrap failed (${response.status}).`);
          error.httpStatus = response.status;
          throw error;
        }
        if (cancelled) return;
        setBootstrapError("");
        if (!bootstrapReadyRef.current) setBootstrapReadyState(true);
      } catch (error) {
        if (cancelled) return;
        const issue = getPlaybackIssue({
          httpStatus: error?.httpStatus,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        });
        reportPlaybackIssue({
          sessionId,
          issue,
          retryAttempt: attempt,
          lastReportedIssueRef,
        });
        const keepPlaying = renewInBackground && bootstrapReadyRef.current && playbackHealthyRef.current;
        if (!keepPlaying) {
          setBootstrapReadyState(false);
          setConnectionIssue(issue);
          setBootstrapError(issue.message);
        }
        bootstrapRetryTimer = window.setTimeout(
          () => void preparePlayback(attempt + 1),
          jitteredBackoffDelay(attempt)
        );
      }
    };

    void preparePlayback();
    return () => {
      cancelled = true;
      if (bootstrapRetryTimer) window.clearTimeout(bootstrapRetryTimer);
    };
  }, [bootstrapGeneration, bootstrapUrl, hlsUrl, refreshKey, sessionId]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
    if (sessionExpectedLive) return;
    // The class really ended: stop waiting for the stream to return.
    reconnectControllerRef.current?.dispose();
    streamOutageRef.current = null;
    setStreamReconnect(null);
  }, [sessionExpectedLive, sessionStatus]);

  // A different stream starts with a clean outage record.
  useEffect(
    () => () => {
      streamOutageRef.current = null;
      hasEverPlayedRef.current = false;
      setStreamReconnect(null);
    },
    [hlsUrl, sessionId]
  );

  useEffect(() => {
    const timers = outageReportTimersRef.current;
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const previousStatus = previousStreamStatusRef.current;
    previousStreamStatusRef.current = normalizedStreamStatus;
    if (!shouldReloadOnStreamLive({ previousStatus, nextStatus: normalizedStreamStatus, recovering: true })) {
      return undefined;
    }
    // Every viewer sees the same status change; spread the reloads out.
    const timer = window.setTimeout(() => {
      if (
        shouldReloadOnStreamLive({
          previousStatus,
          nextStatus: normalizedStreamStatus,
          recovering: recoveringRef.current,
        })
      ) {
        liveResumeRef.current?.();
      }
    }, randomJitterDelay());
    return () => window.clearTimeout(timer);
  }, [normalizedStreamStatus]);

  useEffect(() => {
    if (!bootstrapReady || unsupportedBrowser || !hlsUrl) return undefined;

    const video = videoRef.current;
    if (!video) return undefined;

    let hls = null;
    let disposed = false;
    let recoveryState = { ...initialHlsRecoveryState };
    let manifestParsed = false;
    let hasPlayedFirstFrame = false;
    let consecutiveFreezes = 0;
    let pausedByViewer = false;
    let autoplayBlocked = false;
    let inPlaceTimer = null;
    let lastMediaRecoveryAt = 0;
    let lastRecoveryActionAt = 0;
    let lastPlaybackTime = video.currentTime || 0;
    let lastPlaybackProgressAt = Date.now();
    let startedAt = Date.now();
    // Broadcast-offline handling (encoder blip while the class is live).
    let sawLivePlaylist = false;
    let offlineSlateStart = null;
    let holdingForOutage = false;
    let nativeStallProbe = null;
    let nativeStallProbed = false;
    const probePlaylist = createLivePlaylistProber({ url: hlsUrl });

    playbackHealthyRef.current = false;
    recoveringRef.current = true;
    setAutoplayState("");

    const reconnect = createStreamReconnectController({
      probe: probePlaylist,
      initialAttempt: streamOutageRef.current?.probeAttempt || 0,
      onProbeAttempt: (attempt) => {
        if (streamOutageRef.current) streamOutageRef.current.probeAttempt = attempt;
      },
      onPhaseChange: (phase) => {
        if (disposed || phase !== STREAM_RECONNECT_PHASES.WAITING) return;
        // Everything broadcast before the outage has been watched: stop
        // playing the offline clip and show the overlay. Playback resumes
        // through the reattach once the stream is confirmed live again.
        holdingForOutage = true;
        hls?.stopLoad();
        if (!video.paused) video.pause();
        setConnectionIssue(null);
        setStreamReconnect({
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
          hadPlayback: hasEverPlayedRef.current,
        });
      },
      onReattach: () => {
        if (disposed) return;
        // A fresh player attaches at the live edge. This is not a failure, so
        // it never touches the error ladder or its attempt counter.
        setStreamReconnect(
          (current) => current || { offline: false, hadPlayback: hasEverPlayedRef.current }
        );
        setPlayerGeneration((current) => current + 1);
      },
    });
    reconnectControllerRef.current = reconnect;

    const clearPlayerRetryTimer = () => {
      if (playerRetryTimerRef.current) {
        window.clearTimeout(playerRetryTimerRef.current);
        playerRetryTimerRef.current = null;
      }
    };
    const clearInPlaceTimer = () => {
      if (inPlaceTimer) {
        window.clearTimeout(inPlaceTimer);
        inPlaceTimer = null;
      }
    };
    const resetProgressClock = () => {
      lastPlaybackTime = video.currentTime || 0;
      lastPlaybackProgressAt = Date.now();
      startedAt = Date.now();
    };

    // The broadcast stopped producing video. Unless the backend says the class
    // ended, wait for it to come back instead of giving up. Returns false
    // when the signal does not mean "reconnect".
    const enterStreamOutage = (signal, { tailExhausted = false } = {}) => {
      if (disposed) return false;
      const interruption = classifyStreamInterruption({ signal, sessionStatus: sessionStatusRef.current });
      if (interruption !== STREAM_INTERRUPTIONS.STREAM_OFFLINE) return false;
      if (!reconnect.isActive()) {
        // Pending error recovery would only fight the outage handling.
        clearInPlaceTimer();
        clearPlayerRetryTimer();
        recoveringRef.current = true;
        setConnectionIssue(null);
        if (!streamOutageRef.current) {
          streamOutageRef.current = { startedAt: Date.now(), probeAttempt: 0 };
          queueStreamOutageReport({
            sessionId,
            report: buildStreamOutageReport({ kind: "offline" }),
            timers: outageReportTimersRef.current,
            lastReportedIssueRef,
          });
        }
      }
      reconnect.streamWentOffline({ tailExhausted });
      return true;
    };

    // First real progress after the reattach to the returned stream.
    const confirmStreamRecovered = () => {
      const outage = streamOutageRef.current;
      if (!outage || reconnect.isActive()) return;
      streamOutageRef.current = null;
      setStreamReconnect(null);
      queueStreamOutageReport({
        sessionId,
        report: buildStreamOutageReport({
          kind: "recovered",
          outageMs: Date.now() - outage.startedAt,
          attempt: outage.probeAttempt,
        }),
        timers: outageReportTimersRef.current,
        lastReportedIssueRef,
      });
    };

    const markPlaybackHealthy = () => {
      hasPlayedFirstFrame = true;
      // Buffered media keeps playing for a while after a fatal error, so
      // progress is not proof that a scheduled recovery is unnecessary.
      if (inPlaceTimer || playerRetryTimerRef.current) return;
      playbackHealthyRef.current = true;
      recoveringRef.current = false;
      setConnectionIssue(null);
      // Only sustained playback resets the escalation ladder; otherwise a
      // recovery that plays a few buffered seconds would loop forever.
      if (Date.now() - lastRecoveryActionAt >= HEALTHY_PLAYBACK_CONFIRM_MS) {
        recoveryAttemptRef.current = 0;
        recoveryState = { ...initialHlsRecoveryState };
        consecutiveFreezes = 0;
      }
    };

    const showIssue = (issue) => {
      if (!issue) return;
      playbackHealthyRef.current = false;
      recoveringRef.current = true;
      setConnectionIssue(issue);
      reportPlaybackIssue({
        sessionId,
        issue,
        retryAttempt: recoveryAttemptRef.current,
        lastReportedIssueRef,
      });
    };

    // Try to play; when autoplay with sound is refused, fall back to muted
    // playback and finally to an explicit "click to start" prompt.
    const attemptPlay = () => {
      if (disposed || pausedByViewer || holdingForOutage) return;
      const markAutoplayBlocked = () => {
        if (disposed) return;
        autoplayBlocked = true;
        // Let the viewer's click start playback with sound.
        video.muted = false;
        setAutoplayState("blocked");
        setConnectionIssue(null);
      };
      const playPromise = video.play();
      if (!playPromise || typeof playPromise.catch !== "function") return;
      playPromise.catch((error) => {
        if (disposed || !isAutoplayBlockedError(error)) return;
        if (video.muted) {
          markAutoplayBlocked();
          return;
        }
        video.muted = true;
        const mutedPlayPromise = video.play();
        if (!mutedPlayPromise || typeof mutedPlayPromise.then !== "function") return;
        mutedPlayPromise
          .then(() => {
            if (!disposed) setAutoplayState("muted");
          })
          .catch((mutedError) => {
            if (isAutoplayBlockedError(mutedError)) markAutoplayBlocked();
          });
      });
    };

    // Reconnect without destroying hls.js: reload the manifest if it never
    // arrived, otherwise restart loading (optionally jumping to the live edge).
    const recoverInPlace = ({ seekToLive = false } = {}) => {
      if (disposed) return;
      recoveringRef.current = true;
      lastRecoveryActionAt = Date.now();
      if (hls) {
        if (!manifestParsed) {
          hls.loadSource(hlsUrl);
          return;
        }
        if (seekToLive) {
          const liveSyncPosition = Number(hls.liveSyncPosition);
          if (Number.isFinite(liveSyncPosition) && liveSyncPosition > 0) {
            video.currentTime = liveSyncPosition;
            lastPlaybackTime = liveSyncPosition;
          }
        }
        hls.startLoad();
        attemptPlay();
        return;
      }
      if (seekToLive && video.seekable?.length) {
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(liveEdge) && liveEdge > 0) {
          video.currentTime = Math.max(0, liveEdge - 6);
          lastPlaybackTime = video.currentTime || 0;
        }
      } else {
        video.load();
      }
      attemptPlay();
    };
    const scheduleInPlaceRecovery = (delayMs, options = {}) => {
      if (disposed || inPlaceTimer) return;
      inPlaceTimer = window.setTimeout(() => {
        inPlaceTimer = null;
        recoverInPlace(options);
      }, delayMs);
    };
    liveResumeRef.current = () => {
      if (reconnect.isActive()) {
        // The backend saw the stream come back; check now instead of waiting
        // for the next backoff step.
        reconnect.probeSoon(0);
        return;
      }
      clearInPlaceTimer();
      recoverInPlace({ seekToLive: true });
    };

    // Full teardown (or access renewal) as the last resort, always with
    // jittered backoff so an audience does not reconnect in lock-step.
    const schedulePlayerRecovery = ({ issue = null, renewAccess = false } = {}) => {
      if (disposed || playerRetryTimerRef.current) return;
      showIssue(issue);
      recoveringRef.current = true;
      const attempt = recoveryAttemptRef.current;
      recoveryAttemptRef.current += 1;
      playerRetryTimerRef.current = window.setTimeout(
        () => {
          playerRetryTimerRef.current = null;
          if (disposed) return;
          if (renewAccess) {
            setBootstrapGeneration((current) => current + 1);
          } else {
            setPlayerGeneration((current) => current + 1);
          }
        },
        jitteredBackoffDelay(attempt)
      );
    };

    const applyRecoveryAction = (action, issue) => {
      if (disposed) return;
      switch (action) {
        case RECOVERY_ACTIONS.RENEW_ACCESS:
          schedulePlayerRecovery({ issue, renewAccess: true });
          return;
        case RECOVERY_ACTIONS.REBUILD:
          schedulePlayerRecovery({ issue });
          return;
        case RECOVERY_ACTIONS.IN_PLACE_LOAD:
          showIssue(issue);
          scheduleInPlaceRecovery(jitteredBackoffDelay(Math.max(0, recoveryState.networkAttempts - 1)));
          return;
        case RECOVERY_ACTIONS.RECOVER_MEDIA:
          showIssue(issue);
          lastMediaRecoveryAt = Date.now();
          lastRecoveryActionAt = lastMediaRecoveryAt;
          hls?.recoverMediaError();
          attemptPlay();
          return;
        case RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER:
          showIssue(issue);
          lastMediaRecoveryAt = Date.now();
          lastRecoveryActionAt = lastMediaRecoveryAt;
          hls?.swapAudioCodec();
          hls?.recoverMediaError();
          attemptPlay();
          return;
        default:
      }
    };

    const handleOnline = () => {
      if (reconnect.isActive()) {
        setConnectionIssue(null);
        setStreamReconnect((current) => (current ? { ...current, offline: false } : current));
        reconnect.handleOnline();
        return;
      }
      if (!recoveringRef.current) {
        // hls.js was still retrying on its own; nothing to rebuild.
        setConnectionIssue(null);
        return;
      }
      setConnectionIssue({ message: "Connection restored. Reconnecting the live video..." });
      scheduleInPlaceRecovery(randomJitterDelay(RECONNECT_JITTER_MS), { seekToLive: true });
    };
    const handleOffline = () => {
      if (reconnect.isActive()) {
        setStreamReconnect((current) => (current ? { ...current, offline: true } : current));
        reconnect.handleOffline();
      }
      const issue = getPlaybackIssue({ offline: true });
      setConnectionIssue(issue);
      reportPlaybackIssue({
        sessionId,
        issue,
        retryAttempt: recoveryAttemptRef.current,
        lastReportedIssueRef,
      });
    };
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (reconnect.isActive()) {
        reconnect.handleVisible();
        return;
      }
      resetProgressClock();
      if (hasPlayedFirstFrame && !pausedByViewer && video.readyState < 2) {
        scheduleInPlaceRecovery(randomJitterDelay(RECONNECT_JITTER_MS), { seekToLive: true });
      }
    };
    const handlePlay = () => {
      pausedByViewer = false;
      if (autoplayBlocked) {
        autoplayBlocked = false;
        setAutoplayState("");
      }
      resetProgressClock();
    };
    const handlePause = () => {
      if (video.ended || holdingForOutage) return;
      pausedByViewer = true;
      // A paused player is never "reconnecting"; only keep the banner while
      // a rebuild is actually scheduled.
      if (!playerRetryTimerRef.current) setConnectionIssue(null);
    };
    const handlePlaying = () => {
      lastPlaybackTime = video.currentTime || 0;
      lastPlaybackProgressAt = Date.now();
    };
    const handleTimeUpdate = () => {
      if (video.seeking) return;
      const currentTime = video.currentTime || 0;
      if (currentTime < lastPlaybackTime - 1) {
        // Live sync can move the playhead backwards; track from there.
        lastPlaybackTime = currentTime;
        return;
      }
      if (currentTime <= lastPlaybackTime + 0.1) return;
      lastPlaybackTime = currentTime;
      lastPlaybackProgressAt = Date.now();
      nativeStallProbed = false;
      if (reconnect.isActive()) {
        // Stop at the end of the real class content, before the offline clip.
        if (
          reconnect.getPhase() === STREAM_RECONNECT_PHASES.DRAINING &&
          hasReachedOfflineTail({ currentTime, slateStart: offlineSlateStart })
        ) {
          reconnect.tailExhausted();
        }
        return;
      }
      hasEverPlayedRef.current = true;
      confirmStreamRecovered();
      markPlaybackHealthy();
    };
    const handleEnded = () => {
      if (disposed) return;
      enterStreamOutage(STREAM_OFFLINE_SIGNALS.MEDIA_ENDED, { tailExhausted: true });
    };
    const handleSeeked = () => {
      lastPlaybackTime = video.currentTime || 0;
    };
    const handleVolumeChange = () => {
      if (!video.muted) setAutoplayState((current) => (current === "muted" ? "" : current));
    };
    const handleVideoError = () => {
      if (disposed) return;
      if (reconnect.isActive()) {
        // Decoding the offline clip is part of the outage, not a failure.
        reconnect.tailExhausted();
        return;
      }
      if (hls && Date.now() - lastMediaRecoveryAt < MEDIA_ERROR_DEDUP_MS) return;
      const decision = decideMediaElementEventAction("error", {
        usingHlsJs: Boolean(hls),
        state: recoveryState,
      });
      recoveryState = decision.state;
      applyRecoveryAction(decision.action, getPlaybackIssue({ errorType: Hls.ErrorTypes.MEDIA_ERROR }));
    };
    // Ordinary buffering ("waiting"/"stalled") is left to hls.js's retry
    // policies; only a genuine freeze escalates, in place first.
    const playbackWatchdog = window.setInterval(() => {
      if (disposed) return;
      const currentTime = video.currentTime || 0;
      if (!video.seeking && currentTime > lastPlaybackTime + 0.1) {
        lastPlaybackTime = currentTime;
        lastPlaybackProgressAt = Date.now();
        nativeStallProbed = false;
        return;
      }

      const visible = document.visibilityState === "visible";
      const online = navigator.onLine !== false;
      if (reconnect.isActive()) {
        // Waiting for the broadcast: never escalate, only notice when the
        // buffered tail has run out.
        if (
          reconnect.getPhase() === STREAM_RECONNECT_PHASES.DRAINING &&
          hasReachedOfflineTail({
            ended: video.ended,
            currentTime,
            slateStart: offlineSlateStart,
            msSinceProgress: Date.now() - lastPlaybackProgressAt,
            pausedByViewer,
          })
        ) {
          reconnect.tailExhausted();
        }
        return;
      }

      // Native HLS hides the playlist; when playback stalls, check whether
      // the broadcast itself went offline (once per stall).
      if (
        !hls &&
        hasPlayedFirstFrame &&
        !pausedByViewer &&
        !autoplayBlocked &&
        !video.ended &&
        visible &&
        online &&
        !nativeStallProbe &&
        !nativeStallProbed &&
        Date.now() - lastPlaybackProgressAt >= NATIVE_STALL_PROBE_MS
      ) {
        nativeStallProbed = true;
        const stallProbe = new AbortController();
        nativeStallProbe = stallProbe;
        void probePlaylist(stallProbe.signal).then((outcome) => {
          if (nativeStallProbe !== stallProbe) return;
          nativeStallProbe = null;
          if (disposed || outcome?.result !== PROBE_RESULTS.OFFLINE) return;
          if (Date.now() - lastPlaybackProgressAt < NATIVE_STALL_PROBE_MS) return;
          enterStreamOutage(STREAM_OFFLINE_SIGNALS.PROBE_OFFLINE, { tailExhausted: true });
        });
      }

      const decision = evaluatePlaybackFreeze({
        now: Date.now(),
        lastProgressAt: lastPlaybackProgressAt,
        startedAt,
        hasPlayedFirstFrame,
        paused: pausedByViewer || autoplayBlocked,
        ended: video.ended,
        expectLive: isSessionExpectedLive(sessionStatusRef.current),
        awaitingStream: reconnect.isActive(),
        visible,
        online,
        consecutiveFreezes,
      });
      if (decision.action === RECOVERY_ACTIONS.AWAIT_STREAM) {
        enterStreamOutage(STREAM_OFFLINE_SIGNALS.MEDIA_ENDED, { tailExhausted: true });
        return;
      }
      if (decision.action === "resetClock") {
        resetProgressClock();
        return;
      }
      if (decision.action !== RECOVERY_ACTIONS.IN_PLACE_LOAD && decision.action !== RECOVERY_ACTIONS.REBUILD) {
        return;
      }

      consecutiveFreezes += 1;
      lastPlaybackProgressAt = Date.now();
      startedAt = Date.now();
      const issue = getPlaybackIssue({ errorType: Hls.ErrorTypes.MEDIA_ERROR });
      if (decision.action === RECOVERY_ACTIONS.REBUILD) {
        schedulePlayerRecovery({ issue });
        return;
      }
      showIssue(issue);
      clearInPlaceTimer();
      recoverInPlace({ seekToLive: true });
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("volumechange", handleVolumeChange);
    video.addEventListener("error", handleVideoError);
    video.addEventListener("ended", handleEnded);

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        liveSyncDurationCount: 5,
        liveMaxLatencyDurationCount: 15,
        liveSyncOnStallIncrease: 2,
        maxBufferLength: 45,
        maxMaxBufferLength: 90,
        maxLiveSyncPlaybackRate: 1.05,
        capLevelToPlayerSize: true,
        capLevelOnFPSDrop: true,
        manifestLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10_000,
            maxLoadTimeMs: 30_000,
            timeoutRetry: retryPolicy(4),
            errorRetry: retryPolicy(8),
          },
        },
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10_000,
            maxLoadTimeMs: 30_000,
            timeoutRetry: retryPolicy(4),
            errorRetry: retryPolicy(8),
          },
        },
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 15_000,
            maxLoadTimeMs: 120_000,
            timeoutRetry: retryPolicy(4),
            errorRetry: retryPolicy(10),
          },
        },
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      // Only the first attach loads the source; recoverMediaError re-attaches
      // and hls.js resumes the already-loaded stream by itself.
      hls.once(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(hlsUrl));
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        manifestParsed = true;
        attemptPlay();
      });
      // #EXT-X-ENDLIST on a live class means the encoder dropped (Owncast ends
      // the playlist and appends its offline clip); hls.js would otherwise
      // stop reloading and let the video end for good.
      const handleLevelDetails = (_event, data) => {
        const details = data?.details;
        if (disposed || !details) return;
        if (!isEndedLevelDetails(details)) {
          sawLivePlaylist = true;
          return;
        }
        offlineSlateStart = findOfflineSlateStart(details.fragments);
        // Nothing live was seen on this attach (joined or reattached while
        // offline): never replay the old playlist, wait for the stream.
        enterStreamOutage(STREAM_OFFLINE_SIGNALS.PLAYLIST_ENDED, { tailExhausted: !sawLivePlaylist });
      };
      hls.on(Hls.Events.LEVEL_LOADED, handleLevelDetails);
      hls.on(Hls.Events.LEVEL_UPDATED, handleLevelDetails);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || disposed) return;
        if (reconnect.isActive()) {
          // hls.js failing on the ended playlist or the offline clip is part
          // of the outage and never counts toward the error ladder.
          reconnect.tailExhausted();
          return;
        }
        if (
          isPlaylistMissingError({ type: data.type, details: data.details, httpStatus: data.response?.code }) &&
          enterStreamOutage(STREAM_OFFLINE_SIGNALS.PLAYLIST_MISSING, { tailExhausted: !hasPlayedFirstFrame })
        ) {
          return;
        }
        if (
          data.type === Hls.ErrorTypes.MEDIA_ERROR &&
          Date.now() - lastMediaRecoveryAt < MEDIA_ERROR_DEDUP_MS
        ) {
          return;
        }
        const httpStatus = data.response?.code;
        const issue = getPlaybackIssue({
          errorType: data.type,
          httpStatus,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        });
        const decision = decideHlsErrorAction({ fatal: true, type: data.type, httpStatus }, recoveryState);
        recoveryState = decision.state;
        applyRecoveryAction(decision.action, issue);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      manifestParsed = true;
      video.src = hlsUrl;
      video.load();
      attemptPlay();
    } else {
      setUnsupportedBrowser(true);
    }

    return () => {
      disposed = true;
      liveResumeRef.current = null;
      playbackHealthyRef.current = false;
      reconnect.dispose();
      if (reconnectControllerRef.current === reconnect) reconnectControllerRef.current = null;
      if (nativeStallProbe) {
        nativeStallProbe.abort();
        nativeStallProbe = null;
      }
      clearPlayerRetryTimer();
      clearInPlaceTimer();
      window.clearInterval(playbackWatchdog);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("volumechange", handleVolumeChange);
      video.removeEventListener("error", handleVideoError);
      video.removeEventListener("ended", handleEnded);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [bootstrapReady, hlsUrl, playerGeneration, refreshKey, sessionId, unsupportedBrowser]);

  if (unsupportedBrowser && fallbackEmbedUrl) {
    return (
      <ProtectedPlaybackSurface className="aspect-video w-full" watermarkEnabled live>
        <iframe
          key={`${fallbackEmbedUrl}|${refreshKey}`}
          title={title}
          src={fallbackEmbedUrl}
          className="block h-full w-full"
          allow="autoplay; fullscreen"
          allowFullScreen
        />
      </ProtectedPlaybackSurface>
    );
  }

  return (
    <ProtectedPlaybackSurface
      className="aspect-video w-full"
      watermarkEnabled={bootstrapReady}
      videoRef={videoRef}
      videoSessionKey={`${hlsUrl}|${refreshKey}`}
      playbackRates={[1]}
      live
      autoFullscreenOnLandscape
    >
      {bootstrapReady ? (
        <video
          ref={videoRef}
          className="block h-full w-full bg-black object-contain"
          autoPlay
          playsInline
          preload="auto"
        />
      ) : (
        <PlayerMessage onRetry={retryNow}>
          {bootstrapError || "Preparing secure live video..."}
        </PlayerMessage>
      )}
      {bootstrapReady && autoplayState === "blocked" ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 px-6">
          <button
            type="button"
            data-playback-gesture-ignore="true"
            onClick={startVideoFromGesture}
            className="rounded-full border border-white/25 bg-white/15 px-4 py-2.5 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(0,0,0,0.34)] backdrop-blur transition hover:bg-white/25"
          >
            Click to start the live video
          </button>
        </div>
      ) : null}
      {bootstrapReady && autoplayState === "muted" ? (
        <button
          type="button"
          data-playback-gesture-ignore="true"
          onClick={unmuteVideo}
          className="absolute left-3 top-3 z-30 rounded-full border border-white/20 bg-black/70 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_8px_20px_rgba(0,0,0,0.3)] backdrop-blur transition hover:bg-black/85"
        >
          Tap to unmute
        </button>
      ) : null}
      {bootstrapReady && streamReconnect && sessionExpectedLive && autoplayState !== "blocked" ? (
        <StreamReconnectOverlay
          offline={streamReconnect.offline}
          hadPlayback={streamReconnect.hadPlayback}
          onRetry={retryNow}
        />
      ) : null}
      {bootstrapReady && !sessionExpectedLive ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#161616]/90 px-6 text-center text-sm text-[#C6C6C6]">
          This broadcast session has ended.
        </div>
      ) : null}
      {bootstrapReady && connectionIssue && !streamReconnect && sessionExpectedLive && autoplayState !== "blocked" ? (
        <div className="absolute inset-x-3 top-3 z-30 rounded-xl border border-amber-300/30 bg-[#18140a]/95 px-3 py-2.5 text-center text-xs leading-5 text-amber-100 shadow-[0_12px_30px_rgba(0,0,0,0.34)] backdrop-blur sm:left-1/2 sm:right-auto sm:w-[min(32rem,calc(100%-1.5rem))] sm:-translate-x-1/2">
          <span>{connectionIssue.message}</span>
          <button
            type="button"
            data-playback-gesture-ignore="true"
            onClick={retryNow}
            className="ml-2 whitespace-nowrap font-semibold text-white underline decoration-white/50 underline-offset-2 hover:decoration-white"
          >
            Retry now
          </button>
        </div>
      ) : null}
    </ProtectedPlaybackSurface>
  );
}
