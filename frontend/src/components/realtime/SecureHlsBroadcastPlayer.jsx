import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import ProtectedPlaybackSurface from "../ProtectedPlaybackSurface";

const NETWORK_RETRY_LIMIT = 12;
const NETWORK_RETRY_BASE_MS = 750;

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
  const retryTimerRef = useRef(null);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [bootstrapError, setBootstrapError] = useState("");
  const [useEmbedFallback, setUseEmbedFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBootstrapReady(false);
    setBootstrapError("");
    setUseEmbedFallback(false);

    if (!bootstrapUrl || !hlsUrl) {
      setUseEmbedFallback(Boolean(fallbackEmbedUrl));
      return () => {
        cancelled = true;
      };
    }

    const preparePlayback = async () => {
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
        if (!cancelled) setBootstrapReady(true);
      } catch (error) {
        if (cancelled) return;
        setBootstrapError(error?.message || "Secure stream bootstrap failed.");
        setUseEmbedFallback(Boolean(fallbackEmbedUrl));
      }
    };

    void preparePlayback();
    return () => {
      cancelled = true;
    };
  }, [bootstrapUrl, fallbackEmbedUrl, hlsUrl, refreshKey]);

  useEffect(() => {
    if (!bootstrapReady || useEmbedFallback || !hlsUrl) return undefined;

    const video = videoRef.current;
    if (!video) return undefined;

    let hls = null;
    let disposed = false;
    let networkRetries = 0;

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const scheduleNetworkRecovery = () => {
      if (disposed || !hls) return;
      clearRetryTimer();
      const retryDelay = Math.min(
        8000,
        NETWORK_RETRY_BASE_MS * 2 ** Math.min(networkRetries, 4)
      );
      networkRetries += 1;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (!disposed && hls) hls.startLoad(-1);
      }, retryDelay);
    };

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxBufferLength: 30,
        manifestLoadingMaxRetry: 8,
        manifestLoadingRetryDelay: 750,
        levelLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 8,
        xhrSetup: (xhr) => {
          xhr.withCredentials = true;
        },
      });
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls?.loadSource(hlsUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        networkRetries = 0;
        void video.play().catch(() => {});
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal || disposed) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (networkRetries < NETWORK_RETRY_LIMIT) {
            scheduleNetworkRecovery();
          } else {
            networkRetries = 0;
            scheduleNetworkRecovery();
          }
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
          return;
        }
        setUseEmbedFallback(Boolean(fallbackEmbedUrl));
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      void video.play().catch(() => {});
    } else {
      setUseEmbedFallback(Boolean(fallbackEmbedUrl));
    }

    return () => {
      disposed = true;
      clearRetryTimer();
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [bootstrapReady, fallbackEmbedUrl, hlsUrl, refreshKey, useEmbedFallback]);

  if (useEmbedFallback && fallbackEmbedUrl) {
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
