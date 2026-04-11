import { useEffect, useMemo, useRef, useState } from "react";
import PlaybackWatermark from "./PlaybackWatermark";
import {
  isNestedFullscreenTarget,
  normalizeProtectedPlaybackClassName,
} from "../utils/protectedPlayback";

const VIDEO_SKIP_SECONDS = 10;

function getScreenOrientationController() {
  if (typeof screen === "undefined") return null;
  return screen.orientation || screen.mozOrientation || screen.msOrientation || null;
}

async function lockLandscapeOrientation() {
  const orientationController = getScreenOrientationController();
  if (!orientationController || typeof orientationController.lock !== "function") {
    return false;
  }

  try {
    await orientationController.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

function unlockOrientation() {
  const orientationController = getScreenOrientationController();
  if (!orientationController || typeof orientationController.unlock !== "function") {
    return;
  }

  try {
    orientationController.unlock();
  } catch {
    // Best-effort only. Some browsers reject unlock when they ignored lock.
  }
}

function canFullscreen(element) {
  return Boolean(
    element?.requestFullscreen ||
      element?.webkitRequestFullscreen ||
      element?.mozRequestFullScreen ||
      element?.msRequestFullscreen
  );
}

async function requestElementFullscreen(element) {
  if (!element) return;
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof element.webkitRequestFullscreen === "function") {
    element.webkitRequestFullscreen();
    return;
  }
  if (typeof element.mozRequestFullScreen === "function") {
    element.mozRequestFullScreen();
    return;
  }
  if (typeof element.msRequestFullscreen === "function") {
    element.msRequestFullscreen();
  }
}

async function exitAnyFullscreen() {
  if (typeof document.exitFullscreen === "function") {
    await document.exitFullscreen();
    return;
  }
  if (typeof document.webkitExitFullscreen === "function") {
    document.webkitExitFullscreen();
    return;
  }
  if (typeof document.mozCancelFullScreen === "function") {
    document.mozCancelFullScreen();
    return;
  }
  if (typeof document.msExitFullscreen === "function") {
    document.msExitFullscreen();
  }
}

function getFullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function formatPlaybackTime(totalSeconds) {
  const normalized = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function ProtectedPlaybackSurface({
  children,
  watermarkEnabled = true,
  className = "",
  showFullscreenButton = true,
  watermarkClassName = "",
  fullscreenLabel = "Fullscreen",
  videoRef = null,
  videoSessionKey = "",
}) {
  const containerRef = useRef(null);
  const orientationLockedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoPaused, setVideoPaused] = useState(true);

  useEffect(() => {
    setFullscreenSupported(canFullscreen(containerRef.current));

    const syncFullscreenState = () => {
      const fullscreenElement = getFullscreenElement();
      const container = containerRef.current;

      if (isNestedFullscreenTarget(container, fullscreenElement)) {
        setIsFullscreen(false);
        if (orientationLockedRef.current) {
          unlockOrientation();
          orientationLockedRef.current = false;
        }
        void exitAnyFullscreen();
        return;
      }

      setIsFullscreen(fullscreenElement === container);
      if (!fullscreenElement && orientationLockedRef.current) {
        unlockOrientation();
        orientationLockedRef.current = false;
      }
    };

    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("webkitfullscreenchange", syncFullscreenState);
    document.addEventListener("mozfullscreenchange", syncFullscreenState);
    document.addEventListener("MSFullscreenChange", syncFullscreenState);

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("webkitfullscreenchange", syncFullscreenState);
      document.removeEventListener("mozfullscreenchange", syncFullscreenState);
      document.removeEventListener("MSFullscreenChange", syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoPaused(true);
  }, [videoSessionKey]);

  useEffect(() => {
    const videoElement = videoRef?.current;
    if (!videoElement) return undefined;

    const syncVideoState = () => {
      const nextDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
      const nextTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
      setVideoDuration(nextDuration);
      setVideoCurrentTime(Math.min(nextTime, nextDuration || nextTime));
      setVideoPaused(videoElement.paused);
    };

    syncVideoState();

    const events = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "play",
      "pause",
      "seeking",
      "seeked",
      "ended",
      "emptied",
    ];

    events.forEach((eventName) => {
      videoElement.addEventListener(eventName, syncVideoState);
    });

    return () => {
      events.forEach((eventName) => {
        videoElement.removeEventListener(eventName, syncVideoState);
      });
    };
  }, [videoRef, videoSessionKey]);

  const buttonLabel = useMemo(() => {
    if (isFullscreen) {
      return "Exit Fullscreen";
    }
    return fullscreenLabel;
  }, [fullscreenLabel, isFullscreen]);

  const surfaceClassName = useMemo(() => {
    const normalizedClassName = normalizeProtectedPlaybackClassName(className, isFullscreen);
    return `relative isolate overflow-hidden bg-black ${isFullscreen ? "h-full w-full" : ""} ${normalizedClassName}`.trim();
  }, [className, isFullscreen]);

  const hasVideoControls = Boolean(videoRef);
  const hasSeekableVideo = hasVideoControls && videoDuration > 0;
  const progressPercent = hasSeekableVideo ? Math.min(100, (videoCurrentTime / videoDuration) * 100) : 0;
  const playPauseLabel = videoPaused ? "Play" : "Pause";

  const handleSeekChange = (event) => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    const nextTime = Math.max(0, Number(event.target.value) || 0);
    videoElement.currentTime = nextTime;
    setVideoCurrentTime(nextTime);
  };

  const handleSkipForward = () => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    const resolvedDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : videoDuration;
    const nextTime =
      resolvedDuration > 0
        ? Math.min(resolvedDuration, (videoElement.currentTime || 0) + VIDEO_SKIP_SECONDS)
        : (videoElement.currentTime || 0) + VIDEO_SKIP_SECONDS;

    videoElement.currentTime = nextTime;
    setVideoCurrentTime(nextTime);
  };

  const handleTogglePlayback = async () => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    try {
      if (videoElement.paused) {
        await videoElement.play();
      } else {
        videoElement.pause();
      }
    } catch {
      // Some browsers reject autoplay/play requests without a gesture.
    }
  };

  const handleToggleFullscreen = async () => {
    try {
      if (getFullscreenElement() === containerRef.current) {
        await exitAnyFullscreen();
        if (orientationLockedRef.current) {
          unlockOrientation();
          orientationLockedRef.current = false;
        }
        return;
      }
      await requestElementFullscreen(containerRef.current);
      orientationLockedRef.current = await lockLandscapeOrientation();
    } catch {
      // Best-effort enhancement only. Playback must remain usable if fullscreen fails.
    }
  };

  return (
    <div
      ref={containerRef}
      data-protected-playback-surface="true"
      data-fullscreen={isFullscreen ? "true" : "false"}
      className={surfaceClassName}
    >
      <div
        data-protected-playback-content="true"
        className={`h-full w-full ${isFullscreen ? "flex items-center justify-center bg-black" : ""}`.trim()}
      >
        {children}
      </div>
      <PlaybackWatermark enabled={watermarkEnabled} className={watermarkClassName} />
      {hasVideoControls ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20">
          <div className="pointer-events-auto rounded-2xl border border-white/12 bg-black/72 px-3 py-2.5 shadow-[0_18px_40px_rgba(0,0,0,0.34)] backdrop-blur-md">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-white/90 sm:text-xs">
              <button
                type="button"
                onClick={handleTogglePlayback}
                className="shrink-0 rounded-full border border-white/12 bg-white/10 px-3 py-1.5 transition hover:bg-white/18"
              >
                {playPauseLabel}
              </button>
              <span className="w-11 shrink-0 text-right tabular-nums text-white/75 sm:w-14">
                {formatPlaybackTime(videoCurrentTime)}
              </span>
              <div className="relative flex-1">
                <div className="absolute inset-y-1/2 left-0 right-0 -translate-y-1/2 rounded-full bg-white/12">
                  <div
                    className="h-1.5 rounded-full bg-white/85"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <input
                  type="range"
                  min="0"
                  max={hasSeekableVideo ? videoDuration : 0}
                  step="0.1"
                  value={hasSeekableVideo ? Math.min(videoCurrentTime, videoDuration) : 0}
                  onChange={handleSeekChange}
                  disabled={!hasSeekableVideo}
                  aria-label="Seek through video"
                  className="relative h-6 w-full cursor-pointer appearance-none bg-transparent accent-white disabled:cursor-not-allowed disabled:opacity-45"
                />
              </div>
              <span className="w-11 shrink-0 tabular-nums text-white/75 sm:w-14">
                {formatPlaybackTime(videoDuration)}
              </span>
              <button
                type="button"
                onClick={handleSkipForward}
                disabled={!hasSeekableVideo}
                className="shrink-0 rounded-full border border-white/12 bg-white/10 px-3 py-1.5 transition hover:bg-white/18 disabled:cursor-not-allowed disabled:opacity-45"
              >
                +10s
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {showFullscreenButton && fullscreenSupported ? (
        <div className="pointer-events-none absolute right-3 top-3 z-30">
          <button
            type="button"
            onClick={handleToggleFullscreen}
            className="pointer-events-auto rounded-full border border-white/12 bg-black/55 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/92 shadow-[0_12px_30px_rgba(0,0,0,0.28)] backdrop-blur-sm transition hover:bg-black/70"
          >
            {buttonLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}
