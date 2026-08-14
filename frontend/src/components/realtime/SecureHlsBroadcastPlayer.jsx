import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";

const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 10_000;
const PLAYBACK_WATCHDOG_INTERVAL_MS = 5_000;
const PLAYBACK_FREEZE_THRESHOLD_MS = 20_000;

const exponentialDelay = (attempt) =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 4));

const retryPolicy = (maxNumRetry) => ({
  maxNumRetry,
  retryDelayMs: 500,
  maxRetryDelayMs: 8_000,
  backoff: "exponential",
});

function PlayerMessage({ children }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[#BBBBBB]">
      {children}
    </div>
  );
}

export default function SecureHlsBroadcastPlayer({
  bootstrapUrl = "",
  hlsUrl = "",
  fallbackEmbedUrl = "",
  refreshKey = 0,
  title = "Broadcast Stream",
}) {
  const videoRef = useRef(null);
  const playerRetryTimerRef = useRef(null);
  const recoveryAttemptRef = useRef(0);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");
  const [playerGeneration, setPlayerGeneration] = useState(0);
  const [unsupportedBrowser, setUnsupportedBrowser] = useState(false);

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
          throw new Error(`Secure stream bootstrap failed (${response.status}).`);
        }
        if (cancelled) return;
        setBootstrapError("");
        setBootstrapReady(true);
      } catch (error) {
        if (cancelled) return;
        setBootstrapReady(false);
        setBootstrapError(
          `${error?.message || "Secure stream bootstrap failed."} Reconnecting...`
        );
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
  }, [bootstrapUrl, hlsUrl, refreshKey]);

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
    };

    const schedulePlayerRecovery = ({ immediate = false } = {}) => {
      if (disposed || playerRetryTimerRef.current) return;
      const attempt = recoveryAttemptRef.current;
      recoveryAttemptRef.current += 1;
      playerRetryTimerRef.current = window.setTimeout(
        () => {
          playerRetryTimerRef.current = null;
          if (!disposed) setPlayerGeneration((current) => current + 1);
        },
        immediate ? 0 : exponentialDelay(attempt)
      );
    };

    const handleOnline = () => schedulePlayerRecovery({ immediate: true });
    const handleVisible = () => {
      if (document.visibilityState === "visible" && video.readyState < 2) {
        schedulePlayerRecovery({ immediate: true });
      }
    };
    const handleStalled = () => {
      if (stalledTimer) window.clearTimeout(stalledTimer);
      stalledTimer = window.setTimeout(() => {
        stalledTimer = null;
        if (!disposed && video.readyState < 3) schedulePlayerRecovery();
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
    const handleVideoError = () => schedulePlayerRecovery();
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
        schedulePlayerRecovery({ immediate: true });
      }
    }, PLAYBACK_WATCHDOG_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
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
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecoveryAttempted) {
          mediaRecoveryAttempted = true;
          hls?.recoverMediaError();
          return;
        }
        schedulePlayerRecovery();
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
  }, [bootstrapReady, hlsUrl, playerGeneration, refreshKey, unsupportedBrowser]);

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
        <PlayerMessage>
          {bootstrapError || "Preparing secure live video..."}
        </PlayerMessage>
      )}
    </ProtectedPlaybackSurface>
  );
}
