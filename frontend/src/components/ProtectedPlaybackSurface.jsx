import { useEffect, useMemo, useRef, useState } from "react";
import PlaybackWatermark from "./PlaybackWatermark";
import {
  isNestedFullscreenTarget,
  normalizeProtectedPlaybackClassName,
} from "../utils/protectedPlayback";

const VIDEO_SKIP_SECONDS = 10;
const DOUBLE_TAP_WINDOW_MS = 320;
const SINGLE_CLICK_DELAY_MS = DOUBLE_TAP_WINDOW_MS + 40;
const TAP_MOVEMENT_THRESHOLD_PX = 14;
const VIDEO_REPLAY_THRESHOLD_SECONDS = 0.25;

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

function shouldIgnoreGestureTarget(target) {
  return Boolean(
    target instanceof Element &&
      target.closest(
        "[data-playback-gesture-ignore='true'],button,input,select,textarea,a,[role='button']"
      )
  );
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
  const lastTapRef = useRef({ timestamp: 0, side: "" });
  const singleToggleTimerRef = useRef(null);
  const suppressClickUntilRef = useRef(0);
  const touchGestureRef = useRef({ x: 0, y: 0, moved: false });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(false);

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
    setVideoMuted(false);
  }, [videoSessionKey]);

  function clearSingleToggleTimer() {
    if (singleToggleTimerRef.current && typeof window !== "undefined") {
      window.clearTimeout(singleToggleTimerRef.current);
    }
    singleToggleTimerRef.current = null;
  }

  function resetTouchGesture() {
    touchGestureRef.current = { x: 0, y: 0, moved: false };
  }

  useEffect(() => {
    const videoElement = videoRef?.current;
    if (!videoElement) return undefined;

    const syncVideoState = () => {
      const nextDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : 0;
      const nextTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
      setVideoDuration(nextDuration);
      setVideoCurrentTime(Math.min(nextTime, nextDuration || nextTime));
      setVideoPaused(videoElement.paused);
      setVideoMuted(Boolean(videoElement.muted || videoElement.volume === 0));
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
      "volumechange",
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

  useEffect(() => () => clearSingleToggleTimer(), []);

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
  const muteLabel = videoMuted ? "Unmute" : "Mute";

  const seekBySeconds = (deltaSeconds) => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    const resolvedDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : videoDuration;
    const baseTime = Number(videoElement.currentTime) || 0;
    const unclampedNextTime = baseTime + deltaSeconds;
    const nextTime =
      resolvedDuration > 0
        ? Math.min(resolvedDuration, Math.max(0, unclampedNextTime))
        : Math.max(0, unclampedNextTime);

    videoElement.currentTime = nextTime;
    setVideoCurrentTime(nextTime);
  };

  const resolveTapSide = (clientX) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0) return "";

    return clientX < bounds.left + bounds.width / 2 ? "left" : "right";
  };

  const handleDirectionalSeek = (clientX) => {
    const side = resolveTapSide(clientX);
    if (side === "left") {
      seekBySeconds(-VIDEO_SKIP_SECONDS);
    } else if (side === "right") {
      seekBySeconds(VIDEO_SKIP_SECONDS);
    }
  };

  const handleSeekChange = (event) => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    const nextTime = Math.max(0, Number(event.target.value) || 0);
    videoElement.currentTime = nextTime;
    setVideoCurrentTime(nextTime);
  };

  const handleSkipBackward = () => {
    seekBySeconds(-VIDEO_SKIP_SECONDS);
  };

  const handleSkipForward = () => {
    seekBySeconds(VIDEO_SKIP_SECONDS);
  };

  const handleTogglePlayback = async () => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    try {
      if (videoElement.paused) {
        const resolvedDuration = Number.isFinite(videoElement.duration) ? videoElement.duration : videoDuration;
        const currentTime = Number(videoElement.currentTime) || 0;
        if (resolvedDuration > 0 && currentTime >= Math.max(0, resolvedDuration - VIDEO_REPLAY_THRESHOLD_SECONDS)) {
          videoElement.currentTime = 0;
          setVideoCurrentTime(0);
        }
        await videoElement.play();
      } else {
        videoElement.pause();
      }
    } catch {
      // Some browsers reject autoplay/play requests without a gesture.
    }
  };

  const handleToggleMute = () => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    videoElement.muted = !videoElement.muted;
    setVideoMuted(videoElement.muted);
  };

  const schedulePlaybackToggle = () => {
    if (typeof window === "undefined") {
      void handleTogglePlayback();
      return;
    }

    clearSingleToggleTimer();
    singleToggleTimerRef.current = window.setTimeout(() => {
      singleToggleTimerRef.current = null;
      void handleTogglePlayback();
    }, SINGLE_CLICK_DELAY_MS);
  };

  const handleSurfaceClickCapture = (event) => {
    if (!hasVideoControls || shouldIgnoreGestureTarget(event.target)) return;
    if (Date.now() < suppressClickUntilRef.current) return;
    if (event.detail !== 1) return;

    schedulePlaybackToggle();
  };

  const handleSurfaceDoubleClickCapture = (event) => {
    if (!hasVideoControls || shouldIgnoreGestureTarget(event.target)) return;

    clearSingleToggleTimer();
    handleDirectionalSeek(event.clientX);
    event.preventDefault();
  };

  const handleSurfaceTouchEndCapture = (event) => {
    if (!hasVideoControls || shouldIgnoreGestureTarget(event.target)) return;

    const touchPoint = event.changedTouches?.[0];
    if (!touchPoint) return;
    if (touchGestureRef.current.moved) {
      resetTouchGesture();
      return;
    }

    const side = resolveTapSide(touchPoint.clientX);
    if (!side) {
      resetTouchGesture();
      return;
    }

    suppressClickUntilRef.current = Date.now() + DOUBLE_TAP_WINDOW_MS;
    const now = Date.now();
    const previousTap = lastTapRef.current;
    if (previousTap.side === side && now - previousTap.timestamp <= DOUBLE_TAP_WINDOW_MS) {
      clearSingleToggleTimer();
      handleDirectionalSeek(touchPoint.clientX);
      lastTapRef.current = { timestamp: 0, side: "" };
      resetTouchGesture();
      event.preventDefault();
      return;
    }

    lastTapRef.current = { timestamp: now, side };
    resetTouchGesture();
    schedulePlaybackToggle();
  };

  const handleSurfaceTouchStartCapture = (event) => {
    if (!hasVideoControls || shouldIgnoreGestureTarget(event.target)) return;

    const touchPoint = event.touches?.[0];
    if (!touchPoint) {
      resetTouchGesture();
      return;
    }

    touchGestureRef.current = {
      x: touchPoint.clientX,
      y: touchPoint.clientY,
      moved: false,
    };
  };

  const handleSurfaceTouchMoveCapture = (event) => {
    if (!hasVideoControls || shouldIgnoreGestureTarget(event.target)) return;

    const touchPoint = event.touches?.[0];
    if (!touchPoint) return;

    const deltaX = Math.abs(touchPoint.clientX - touchGestureRef.current.x);
    const deltaY = Math.abs(touchPoint.clientY - touchGestureRef.current.y);
    if (deltaX > TAP_MOVEMENT_THRESHOLD_PX || deltaY > TAP_MOVEMENT_THRESHOLD_PX) {
      touchGestureRef.current.moved = true;
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
      style={{ touchAction: hasVideoControls ? "manipulation" : undefined }}
      onClickCapture={handleSurfaceClickCapture}
      onDoubleClickCapture={handleSurfaceDoubleClickCapture}
      onTouchStartCapture={handleSurfaceTouchStartCapture}
      onTouchMoveCapture={handleSurfaceTouchMoveCapture}
      onTouchEndCapture={handleSurfaceTouchEndCapture}
      onTouchCancelCapture={resetTouchGesture}
    >
      <div
        data-protected-playback-content="true"
        className={`h-full w-full ${isFullscreen ? "flex items-center justify-center bg-black" : ""}`.trim()}
      >
        {children}
      </div>
      {hasVideoControls ? (
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,10,0.22)_0%,rgba(5,6,10,0)_38%,rgba(5,6,10,0.14)_62%,rgba(5,6,10,0.72)_100%)]" />
      ) : null}
      <PlaybackWatermark enabled={watermarkEnabled} className={watermarkClassName} />
      {hasVideoControls && videoPaused ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <button
            type="button"
            data-playback-gesture-ignore="true"
            onClick={() => {
              clearSingleToggleTimer();
              void handleTogglePlayback();
            }}
            className="pointer-events-auto inline-flex h-16 w-16 items-center justify-center rounded-full border border-white/15 bg-white/12 text-sm font-semibold text-white shadow-[0_18px_55px_rgba(0,0,0,0.45)] backdrop-blur-md transition hover:bg-white/18 sm:h-20 sm:w-20 sm:text-base"
          >
            Play
          </button>
        </div>
      ) : null}
      {hasVideoControls ? (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20">
          <div
            data-playback-gesture-ignore="true"
            className="pointer-events-auto rounded-[24px] border border-white/12 bg-[linear-gradient(180deg,rgba(15,18,26,0.88),rgba(8,10,16,0.74))] px-3 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.34)] backdrop-blur-xl"
          >
            <div className="mb-2 flex items-center gap-3">
              <span className="w-11 shrink-0 text-right text-[11px] font-semibold tabular-nums text-white/70 sm:w-14 sm:text-xs">
                {formatPlaybackTime(videoCurrentTime)}
              </span>
              <div className="relative flex-1">
                <div className="absolute inset-y-1/2 left-0 right-0 -translate-y-1/2 rounded-full bg-white/12">
                  <div
                    className="h-1.5 rounded-full bg-[linear-gradient(90deg,#8b5cf6,#ec4899,#f59e0b)]"
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
                  className="relative h-6 w-full cursor-pointer appearance-none bg-transparent accent-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-45"
                />
              </div>
              <span className="w-11 shrink-0 text-[11px] font-semibold tabular-nums text-white/70 sm:w-14 sm:text-xs">
                {formatPlaybackTime(videoDuration)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-white/90 sm:text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSkipBackward}
                  disabled={!hasSeekableVideo}
                  className="shrink-0 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 transition hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  -10s
                </button>
                <button
                  type="button"
                  onClick={() => void handleTogglePlayback()}
                  className="shrink-0 rounded-full border border-white/12 bg-white px-4 py-1.5 text-[#14161d] transition hover:bg-white/90"
                >
                  {playPauseLabel}
                </button>
                <button
                  type="button"
                  onClick={handleSkipForward}
                  disabled={!hasSeekableVideo}
                  className="shrink-0 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 transition hover:bg-white/16 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  +10s
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="shrink-0 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 transition hover:bg-white/16"
                >
                  {muteLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {showFullscreenButton && fullscreenSupported ? (
        <div
          data-playback-gesture-ignore="true"
          className="pointer-events-none absolute right-3 top-3 z-30"
        >
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
