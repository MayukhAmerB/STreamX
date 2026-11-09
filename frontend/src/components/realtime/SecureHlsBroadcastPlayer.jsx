import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { reportRealtimeBroadcastPlaybackIssue } from "../../api/realtime";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";
import {
  RECOVERY_ACTIONS,
  decideHlsErrorAction,
  decideMediaElementEventAction,
  evaluatePlaybackFreeze,
  initialHlsRecoveryState,
  isAutoplayBlockedError,
  jitteredBackoffDelay,
  normalizeStreamStatus,
  randomJitterDelay,
  shouldReloadOnStreamLive,
  shouldRenewBootstrapInBackground,
} from "../../utils/hlsPlaybackRecovery";

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

export default function SecureHlsBroadcastPlayer({
  sessionId = null,
  bootstrapUrl = "",
  hlsUrl = "",
  fallbackEmbedUrl = "",
  refreshKey = 0,
  streamStatus = "",
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
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");
  const [connectionIssue, setConnectionIssue] = useState(null);
  const [bootstrapGeneration, setBootstrapGeneration] = useState(0);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [unsupportedBrowser, setUnsupportedBrowser] = useState(false);
  // "" while playback is normal, "muted" after autoplay only succeeded muted,
  // "blocked" when the browser requires a click before any playback.
  const [autoplayState, setAutoplayState] = useState("");
  const normalizedStreamStatus = normalizeStreamStatus(streamStatus);

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

    playbackHealthyRef.current = false;
    recoveringRef.current = true;
    setAutoplayState("");

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
      if (disposed || pausedByViewer) return;
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
      if (!recoveringRef.current) {
        // hls.js was still retrying on its own; nothing to rebuild.
        setConnectionIssue(null);
        return;
      }
      setConnectionIssue({ message: "Connection restored. Reconnecting the live video..." });
      scheduleInPlaceRecovery(randomJitterDelay(RECONNECT_JITTER_MS), { seekToLive: true });
    };
    const handleOffline = () => {
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
      if (video.ended) return;
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
      markPlaybackHealthy();
    };
    const handleSeeked = () => {
      lastPlaybackTime = video.currentTime || 0;
    };
    const handleVolumeChange = () => {
      if (!video.muted) setAutoplayState((current) => (current === "muted" ? "" : current));
    };
    const handleVideoError = () => {
      if (disposed) return;
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
        return;
      }

      const decision = evaluatePlaybackFreeze({
        now: Date.now(),
        lastProgressAt: lastPlaybackProgressAt,
        startedAt,
        hasPlayedFirstFrame,
        paused: pausedByViewer || autoplayBlocked,
        ended: video.ended,
        visible: document.visibilityState === "visible",
        online: navigator.onLine !== false,
        consecutiveFreezes,
      });
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
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || disposed) return;
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
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [bootstrapReady, hlsUrl, playerGeneration, refreshKey, sessionId, unsupportedBrowser]);

  if (unsupportedBrowser && fallbackEmbedUrl) {
    return (
      <ProtectedPlaybackSurface className="aspect-video w-full" watermarkEnabled>
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
          className="absolute bottom-3 left-3 z-30 rounded-full border border-white/20 bg-black/70 px-3 py-1.5 text-xs font-semibold text-white shadow-[0_8px_20px_rgba(0,0,0,0.3)] backdrop-blur transition hover:bg-black/85"
        >
          Tap to unmute
        </button>
      ) : null}
      {bootstrapReady && connectionIssue && autoplayState !== "blocked" ? (
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
