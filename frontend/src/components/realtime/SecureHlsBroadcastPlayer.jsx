import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { reportRealtimeBroadcastPlaybackIssue } from "../../api/realtime";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";

const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 10_000;
const PLAYBACK_WATCHDOG_INTERVAL_MS = 5_000;
const PLAYBACK_FREEZE_THRESHOLD_MS = 20_000;
const PLAYBACK_REPORT_DEDUP_MS = 30_000;

const exponentialDelay = (attempt) =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 4));

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
  title = "Broadcast Stream",
}) {
  const videoRef = useRef(null);
  const playerRetryTimerRef = useRef(null);
  const recoveryAttemptRef = useRef(0);
  const lastReportedIssueRef = useRef({ key: "", reportedAt: 0 });
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");
  const [connectionIssue, setConnectionIssue] = useState(null);
  const [bootstrapGeneration, setBootstrapGeneration] = useState(0);
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [unsupportedBrowser, setUnsupportedBrowser] = useState(false);

  const retryNow = () => {
    setConnectionIssue({ message: "Retrying the secure video connection..." });
    setBootstrapGeneration((current) => current + 1);
  };

  useEffect(() => {
    let cancelled = false;
    let bootstrapRetryTimer = null;

    setBootstrapReady(false);
    setBootstrapError("");
    setUnsupportedBrowser(false);
    setPlayerGeneration(0);
    recoveryAttemptRef.current = 0;

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
        setBootstrapReady(true);
      } catch (error) {
        if (cancelled) return;
        setBootstrapReady(false);
        const issue = getPlaybackIssue({
          httpStatus: error?.httpStatus,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        });
        setConnectionIssue(issue);
        setBootstrapError(issue.message);
        reportPlaybackIssue({
          sessionId,
          issue,
          retryAttempt: attempt,
          lastReportedIssueRef,
        });
        bootstrapRetryTimer = window.setTimeout(
          () => void preparePlayback(attempt + 1),
          exponentialDelay(attempt)
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
    if (!bootstrapReady || unsupportedBrowser || !hlsUrl) return undefined;

    const video = videoRef.current;
    if (!video) return undefined;

    let hls = null;
    let disposed = false;
    let mediaRecoveryAttempted = false;
    let stalledTimer = null;
    let lastPlaybackTime = video.currentTime || 0;
    let lastPlaybackProgressAt = Date.now();

    const clearPlayerRetryTimer = () => {
      if (playerRetryTimerRef.current) {
        window.clearTimeout(playerRetryTimerRef.current);
        playerRetryTimerRef.current = null;
      }
    };

    const markPlaybackHealthy = () => {
      recoveryAttemptRef.current = 0;
      mediaRecoveryAttempted = false;
      clearPlayerRetryTimer();
      setConnectionIssue(null);
    };

    const schedulePlayerRecovery = ({ immediate = false, issue = null, renewAccess = false } = {}) => {
      if (disposed || playerRetryTimerRef.current) return;
      if (issue) {
        setConnectionIssue(issue);
        reportPlaybackIssue({
          sessionId,
          issue,
          retryAttempt: recoveryAttemptRef.current,
          lastReportedIssueRef,
        });
      }
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
        immediate ? 0 : exponentialDelay(attempt)
      );
    };

    const handleOnline = () => {
      setConnectionIssue({ message: "Connection restored. Reconnecting the live video..." });
      schedulePlayerRecovery({ immediate: true, renewAccess: true });
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
      if (document.visibilityState === "visible" && video.readyState < 2) {
        schedulePlayerRecovery({ immediate: true });
      }
    };
    const handleStalled = () => {
      if (stalledTimer) window.clearTimeout(stalledTimer);
      stalledTimer = window.setTimeout(() => {
        stalledTimer = null;
        if (!disposed && video.readyState < 3) {
          schedulePlayerRecovery({
            issue: getPlaybackIssue({ errorType: Hls.ErrorTypes.MEDIA_ERROR }),
          });
        }
      }, 6_000);
    };
    const handlePlaying = () => {
      if (stalledTimer) {
        window.clearTimeout(stalledTimer);
        stalledTimer = null;
      }
      lastPlaybackTime = video.currentTime || 0;
      lastPlaybackProgressAt = Date.now();
      markPlaybackHealthy();
    };
    const handleTimeUpdate = () => {
      const currentTime = video.currentTime || 0;
      if (currentTime <= lastPlaybackTime + 0.1) return;
      lastPlaybackTime = currentTime;
      lastPlaybackProgressAt = Date.now();
      markPlaybackHealthy();
    };
    const handleVideoError = () =>
      schedulePlayerRecovery({ issue: getPlaybackIssue({ errorType: Hls.ErrorTypes.MEDIA_ERROR }) });
    const playbackWatchdog = window.setInterval(() => {
      if (
        disposed ||
        video.paused ||
        video.ended ||
        !navigator.onLine ||
        document.visibilityState !== "visible"
      ) {
        lastPlaybackTime = video.currentTime || 0;
        lastPlaybackProgressAt = Date.now();
        return;
      }

      const currentTime = video.currentTime || 0;
      if (currentTime > lastPlaybackTime + 0.1) {
        lastPlaybackTime = currentTime;
        lastPlaybackProgressAt = Date.now();
        return;
      }

      if (Date.now() - lastPlaybackProgressAt >= PLAYBACK_FREEZE_THRESHOLD_MS) {
        lastPlaybackProgressAt = Date.now();
        schedulePlayerRecovery({
          immediate: true,
          issue: getPlaybackIssue({ errorType: Hls.ErrorTypes.MEDIA_ERROR }),
        });
      }
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("stalled", handleStalled);
    video.addEventListener("waiting", handleStalled);
    video.addEventListener("timeupdate", handleTimeUpdate);
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
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(hlsUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        markPlaybackHealthy();
        void video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || disposed) return;
        const issue = getPlaybackIssue({
          errorType: data.type,
          httpStatus: data.response?.code,
          offline: typeof navigator !== "undefined" && navigator.onLine === false,
        });
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
          mediaRecoveryAttempted = true;
          setConnectionIssue(issue);
          reportPlaybackIssue({
            sessionId,
            issue,
            retryAttempt: recoveryAttemptRef.current,
            lastReportedIssueRef,
          });
          hls?.recoverMediaError();
          return;
        }
        schedulePlayerRecovery({
          issue,
          renewAccess: issue.reason === "authorization",
        });
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.load();
      void video.play().catch(() => {});
    } else {
      setUnsupportedBrowser(true);
    }

    return () => {
      disposed = true;
      clearPlayerRetryTimer();
      window.clearInterval(playbackWatchdog);
      if (stalledTimer) window.clearTimeout(stalledTimer);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("stalled", handleStalled);
      video.removeEventListener("waiting", handleStalled);
      video.removeEventListener("timeupdate", handleTimeUpdate);
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
      {bootstrapReady && connectionIssue ? (
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
