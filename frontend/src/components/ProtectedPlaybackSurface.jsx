import "./ProtectedPlaybackSurface.css";

import {
  Checkmark,
  Forward_10,
  Maximize,
  Minimize,
  PauseFilled,
  PlayFilledAlt,
  Rewind_10,
  Settings,
  VolumeMuteFilled,
  VolumeUpFilled,
} from "@carbon/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import PlaybackWatermark from "./PlaybackWatermark";
import { useMediaQuery } from "../features/app-shell/useBreakpoint";
import {
  isNestedFullscreenTarget,
  normalizeProtectedPlaybackClassName,
} from "../utils/protectedPlayback";
import {
  CONTROLS_AUTO_HIDE_MS,
  DEFAULT_PLAYBACK_RATES,
  formatPlaybackRate,
  formatPlaybackTime,
  formatSeekValueText,
  getNextPlaybackRate,
  getProgressPercent,
  isLiveDuration,
  isMostlyInViewport,
  normalizePlaybackRates,
  resolveControlsLayout,
} from "../utils/playbackControls";

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

function shouldUseAppFullscreen() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const platform = navigator.platform || "";
  const userAgent = navigator.userAgent || "";
  return (
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (platform === "MacIntel" && Number(navigator.maxTouchPoints) > 1)
  );
}

const TOUCH_CLICK_SUPPRESSION_MS = SINGLE_CLICK_DELAY_MS + 220;

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

function shouldIgnoreGestureTarget(target) {
  return Boolean(
    typeof Element !== "undefined" &&
      target instanceof Element &&
      target.closest(
        "[data-playback-gesture-ignore='true'],button,input,select,textarea,a,[role='button']"
      )
  );
}

function isKeyboardFocus(target) {
  try {
    return typeof target?.matches === "function" ? target.matches(":focus-visible") : false;
  } catch {
    // Browsers without :focus-visible: treat focus as keyboard focus.
    return true;
  }
}

// Phones held sideways: the video takes the whole screen, like video apps.
const LANDSCAPE_PHONE_QUERY = "(orientation: landscape) and (pointer: coarse) and (max-height: 540px)";

function ControlButton({ label, icon: Icon, iconSize = 20, className = "", ...props }) {
  return (
    <button type="button" className={`pps-btn ${className}`.trim()} aria-label={label} {...props}>
      <Icon size={iconSize} aria-hidden="true" />
    </button>
  );
}

/**
 * Shared protected video surface: watermark, signed-stream friendly
 * fullscreen (native or "app" fallback), and a YouTube-style control bar
 * (icons, scrubber, time, speed, quality, fullscreen) that fades out while
 * playing. Styles live in ProtectedPlaybackSurface.css under a `pps-`
 * prefix so the player looks the same inside and outside the Carbon shell.
 */
export default function ProtectedPlaybackSurface({
  children,
  watermarkEnabled = true,
  className = "",
  showFullscreenButton = true,
  watermarkClassName = "",
  fullscreenLabel = "Fullscreen",
  videoRef = null,
  videoSessionKey = "",
  qualityOptions = [],
  selectedQuality = "auto",
  onQualityChange = null,
  activeQualityLabel = "",
  qualityControlMessage = "",
  showQualityControl = false,
  playbackRates = DEFAULT_PLAYBACK_RATES,
  live = false,
  autoFullscreenOnLandscape = false,
}) {
  const containerRef = useRef(null);
  const gestureSurfaceRef = useRef(null);
  const qualityMenuRef = useRef(null);
  const orientationLockedRef = useRef(false);
  const autoFullscreenRef = useRef(false);
  const lastTapRef = useRef({ timestamp: 0, side: "" });
  const singleToggleTimerRef = useRef(null);
  const controlsHideTimerRef = useRef(null);
  const suppressClickUntilRef = useRef(0);
  const touchGestureRef = useRef({ x: 0, y: 0, moved: false });
  const videoPausedRef = useRef(true);
  const controlsVisibleRef = useRef(true);
  // Keeps the bar on screen while it has keyboard focus or a menu is open.
  const controlsPinnedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAppFullscreen, setIsAppFullscreen] = useState(false);
  const [controlsVisible, setControlsVisibleState] = useState(true);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoPaused, setVideoPaused] = useState(true);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoPlaybackRate, setVideoPlaybackRate] = useState(1);
  const [videoIsLive, setVideoIsLive] = useState(false);
  const [hasVideoElement, setHasVideoElement] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const coarsePointer = useMediaQuery("(pointer: coarse)");

  videoPausedRef.current = videoPaused;

  const setControlsVisible = (visible) => {
    controlsVisibleRef.current = visible;
    setControlsVisibleState(visible);
  };

  useEffect(() => {
    if (typeof document === "undefined") return undefined;

    const syncFullscreenState = () => {
      const fullscreenElement = getFullscreenElement();
      const container = containerRef.current;

      if (isNestedFullscreenTarget(container, fullscreenElement)) {
        setIsFullscreen(false);
        setIsAppFullscreen(false);
        if (orientationLockedRef.current) {
          unlockOrientation();
          orientationLockedRef.current = false;
        }
        void exitAnyFullscreen();
        return;
      }

      setIsFullscreen(fullscreenElement === container);
      if (fullscreenElement === container) {
        setIsAppFullscreen(false);
      }
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
  }, [videoSessionKey]);

  useEffect(() => {
    setVideoCurrentTime(0);
    setVideoDuration(0);
    setVideoPaused(true);
    setVideoMuted(false);
    setVideoPlaybackRate(1);
    setVideoIsLive(false);
  }, [videoSessionKey]);

  function clearSingleToggleTimer() {
    if (singleToggleTimerRef.current && typeof window !== "undefined") {
      window.clearTimeout(singleToggleTimerRef.current);
    }
    singleToggleTimerRef.current = null;
  }

  function clearControlsHideTimer() {
    if (controlsHideTimerRef.current && typeof window !== "undefined") {
      window.clearTimeout(controlsHideTimerRef.current);
    }
    controlsHideTimerRef.current = null;
  }

  function releaseOrientationLock() {
    if (!orientationLockedRef.current) {
      return;
    }

    unlockOrientation();
    orientationLockedRef.current = false;
  }

  function resetTouchGesture() {
    touchGestureRef.current = { x: 0, y: 0, moved: false };
  }

  useEffect(() => {
    let videoElement = null;

    const syncVideoState = () => {
      if (!videoElement) return;

      const rawDuration = videoElement.duration;
      const nextDuration = Number.isFinite(rawDuration) ? rawDuration : 0;
      const nextTime = Number.isFinite(videoElement.currentTime) ? videoElement.currentTime : 0;
      setVideoDuration(nextDuration);
      setVideoCurrentTime(Math.min(nextTime, nextDuration || nextTime));
      setVideoPaused(Boolean(videoElement.paused));
      setVideoMuted(Boolean(videoElement.muted || videoElement.volume === 0));
      setVideoPlaybackRate(Number(videoElement.playbackRate) || 1);
      setVideoIsLive(isLiveDuration(rawDuration));
    };

    const events = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "play",
      "playing",
      "pause",
      "canplay",
      "seeking",
      "seeked",
      "ended",
      "emptied",
      "volumechange",
      "ratechange",
    ];

    const unbindVideoElement = () => {
      if (!videoElement) return;

      events.forEach((eventName) => {
        videoElement.removeEventListener(eventName, syncVideoState);
      });
      videoElement = null;
    };

    const bindVideoElement = () => {
      const nextVideoElement = videoRef?.current || null;
      setHasVideoElement(Boolean(nextVideoElement));
      if (!nextVideoElement || nextVideoElement === videoElement) return;

      unbindVideoElement();
      videoElement = nextVideoElement;
      events.forEach((eventName) => {
        videoElement.addEventListener(eventName, syncVideoState);
      });
      syncVideoState();
    };

    bindVideoElement();

    // Signed HLS preparation renders the video after this surface mounts.
    // Observe that delayed insertion so playback state never stays at its
    // initial paused value after the stream has already started.
    const observer =
      typeof MutationObserver !== "undefined" && containerRef.current
        ? new MutationObserver(bindVideoElement)
        : null;
    observer?.observe(containerRef.current, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      unbindVideoElement();
    };
  }, [videoRef, videoSessionKey]);

  useEffect(() => () => {
    clearSingleToggleTimer();
    clearControlsHideTimer();
    releaseOrientationLock();
  }, []);

  // The player's own width picks the desktop bar or the touch layout.
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setSurfaceWidth(Math.round(entry?.contentRect?.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const hasVideoControls = Boolean(videoRef);
  // Controls only make sense once a <video> is mounted (signed live streams
  // show a "preparing" message first).
  const showVideoChrome = hasVideoControls && hasVideoElement;
  const isImmersiveFullscreen = isFullscreen || isAppFullscreen;
  const isLive = Boolean(live) || videoIsLive;
  // App fullscreen is a reliable fallback for iframe players and mobile
  // browsers that expose but reject the native Fullscreen API.
  const canUseFullscreenControl = showFullscreenButton;
  const canSelectQuality =
    showQualityControl && Array.isArray(qualityOptions) && qualityOptions.length > 1 && typeof onQualityChange === "function";
  const shouldShowQualityBadge = showQualityControl && !canSelectQuality && Boolean(activeQualityLabel);
  const availablePlaybackRates = normalizePlaybackRates(playbackRates);
  const canChangePlaybackRate = !isLive && availablePlaybackRates.length > 1;
  const qualityButtonLabel =
    activeQualityLabel
    || qualityOptions.find((option) => option.value === selectedQuality)?.label
    || "HD";
  const controlsLayout = resolveControlsLayout({ width: surfaceWidth, coarsePointer });
  const isTouchLayout = controlsLayout === "touch";

  const scheduleControlsAutoHide = () => {
    clearControlsHideTimer();
    if (typeof window === "undefined") return;

    controlsHideTimerRef.current = window.setTimeout(() => {
      controlsHideTimerRef.current = null;
      if (videoPausedRef.current || controlsPinnedRef.current) return;
      setControlsVisible(false);
    }, CONTROLS_AUTO_HIDE_MS);
  };

  const revealControls = ({ autoHide = true } = {}) => {
    clearControlsHideTimer();
    if (!controlsVisibleRef.current) setControlsVisible(true);

    if (!autoHide || !hasVideoControls || videoPausedRef.current) {
      return;
    }

    scheduleControlsAutoHide();
  };

  const hideControlsNow = () => {
    clearControlsHideTimer();
    if (videoPausedRef.current || controlsPinnedRef.current) return;
    setControlsVisible(false);
  };

  const scheduleControlsToggle = () => {
    const toggle = () => {
      if (controlsVisibleRef.current && !videoPausedRef.current) {
        hideControlsNow();
      } else {
        revealControls();
      }
    };

    if (typeof window === "undefined") {
      toggle();
      return;
    }

    clearSingleToggleTimer();
    singleToggleTimerRef.current = window.setTimeout(() => {
      singleToggleTimerRef.current = null;
      toggle();
    }, SINGLE_CLICK_DELAY_MS);
  };

  useEffect(() => {
    if (!isAppFullscreen || typeof document === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const body = document.body;
    const previousRootOverflow = root.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyTouchAction = body.style.touchAction;
    const previousSiteZoom = root.style.getPropertyValue("--site-zoom");

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.touchAction = "none";
    root.style.setProperty("--site-zoom", "1");

    return () => {
      root.style.overflow = previousRootOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.touchAction = previousBodyTouchAction;
      if (previousSiteZoom) {
        root.style.setProperty("--site-zoom", previousSiteZoom);
      } else {
        root.style.removeProperty("--site-zoom");
      }
    };
  }, [isAppFullscreen]);

  useEffect(() => {
    if (!isAppFullscreen || typeof window === "undefined") {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        autoFullscreenRef.current = false;
        setIsAppFullscreen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isAppFullscreen]);

  // Phones: turning the phone sideways while the video plays fills the
  // screen; turning it back returns to the page (only if it was automatic).
  // Uses the CSS "app" fullscreen because the Fullscreen API needs a tap.
  useEffect(() => {
    if (!autoFullscreenOnLandscape || !hasVideoControls || typeof window === "undefined" || !window.matchMedia) {
      return undefined;
    }

    const query = window.matchMedia(LANDSCAPE_PHONE_QUERY);
    let frame = 0;
    const applyOrientation = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (query.matches) {
          if (getFullscreenElement() || videoPausedRef.current || !videoRef?.current) return;
          const rect = containerRef.current?.getBoundingClientRect?.();
          if (!isMostlyInViewport(rect, window.innerHeight)) return;
          autoFullscreenRef.current = true;
          setIsAppFullscreen(true);
          return;
        }
        if (autoFullscreenRef.current) {
          autoFullscreenRef.current = false;
          setIsAppFullscreen(false);
        }
      });
    };

    query.addEventListener?.("change", applyOrientation);
    return () => {
      window.cancelAnimationFrame(frame);
      query.removeEventListener?.("change", applyOrientation);
    };
  }, [autoFullscreenOnLandscape, hasVideoControls, videoRef]);

  useEffect(() => {
    if (!isImmersiveFullscreen) {
      releaseOrientationLock();
    }

    if (videoPaused) {
      clearControlsHideTimer();
      setControlsVisible(true);
      return;
    }

    revealControls();
    // Runs when playback starts/stops or fullscreen changes; the helpers it
    // calls only read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImmersiveFullscreen, videoPaused, videoSessionKey]);

  const buttonLabel = useMemo(() => {
    if (isImmersiveFullscreen) {
      return "Exit fullscreen";
    }
    return fullscreenLabel;
  }, [fullscreenLabel, isImmersiveFullscreen]);

  const surfaceClassName = useMemo(() => {
    if (isAppFullscreen) {
      return "pps-surface fixed inset-0 z-[9999] flex h-[100dvh] w-[100dvw] flex-col overflow-hidden bg-black";
    }
    return `pps-surface relative isolate bg-black ${isImmersiveFullscreen ? "flex h-full w-full flex-col overflow-hidden" : ""}`.trim();
  }, [isAppFullscreen, isImmersiveFullscreen]);

  const stageClassName = useMemo(() => {
    const normalizedClassName = normalizeProtectedPlaybackClassName(className, isImmersiveFullscreen);
    return `relative overflow-hidden bg-black ${isImmersiveFullscreen ? "flex min-h-0 flex-1 items-center justify-center" : ""} ${normalizedClassName}`.trim();
  }, [className, isImmersiveFullscreen]);

  const hasSeekableVideo = hasVideoControls && videoDuration > 0 && !isLive;
  const progressPercent = hasSeekableVideo ? getProgressPercent(videoCurrentTime, videoDuration) : 0;
  const playPauseLabel = videoPaused ? "Play" : "Pause";
  const muteLabel = videoMuted ? "Unmute" : "Mute";
  const shouldShowControls = controlsVisible || videoPaused || qualityMenuOpen;

  useEffect(() => {
    if (!canSelectQuality) {
      setQualityMenuOpen(false);
    }
  }, [canSelectQuality]);

  useEffect(() => {
    if (shouldShowControls) return;
    setQualityMenuOpen(false);
  }, [shouldShowControls]);

  useEffect(() => {
    if (!qualityMenuOpen || typeof document === "undefined") {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (qualityMenuRef.current && !qualityMenuRef.current.contains(event.target)) {
        setQualityMenuOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setQualityMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [qualityMenuOpen]);

  const seekBySeconds = (deltaSeconds) => {
    const videoElement = videoRef?.current;
    // Live streams are never scrubbed (the recovery logic owns the live edge).
    if (!videoElement || isLive) return;

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

  const resolveTapSide = (clientX, boundsSource = gestureSurfaceRef.current || containerRef.current) => {
    const bounds = boundsSource?.getBoundingClientRect?.();
    if (!bounds || bounds.width <= 0) return "";

    return clientX < bounds.left + bounds.width / 2 ? "left" : "right";
  };

  const handleDirectionalSeek = (clientX, boundsSource = gestureSurfaceRef.current || containerRef.current) => {
    const side = resolveTapSide(clientX, boundsSource);
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
    revealControls();
  };

  const handleSkipForward = () => {
    seekBySeconds(VIDEO_SKIP_SECONDS);
    revealControls();
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

  const handlePlaybackRateChange = (rate) => {
    const videoElement = videoRef?.current;
    if (!videoElement) return;

    videoElement.playbackRate = rate;
    setVideoPlaybackRate(rate);
  };

  const handleCyclePlaybackRate = () => {
    handlePlaybackRateChange(getNextPlaybackRate(availablePlaybackRates, videoPlaybackRate));
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

  // Mouse: a click plays/pauses and a double click seeks, like desktop players.
  const handleSurfaceClickCapture = (event) => {
    if (!showVideoChrome || shouldIgnoreGestureTarget(event.target)) return;
    if (Date.now() < suppressClickUntilRef.current) return;
    if (event.detail !== 1) return;

    revealControls();
    schedulePlaybackToggle();
  };

  const handleSurfaceDoubleClickCapture = (event) => {
    if (!showVideoChrome) return;

    clearSingleToggleTimer();
    revealControls();
    handleDirectionalSeek(event.clientX, event.currentTarget);
    event.preventDefault();
  };

  // Touch: a tap shows/hides the controls and a double tap seeks 10s, like
  // phone video apps.
  const handleSurfaceTouchEndCapture = (event) => {
    if (!showVideoChrome) return;

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

    suppressClickUntilRef.current = Date.now() + TOUCH_CLICK_SUPPRESSION_MS;
    const now = Date.now();
    const previousTap = lastTapRef.current;
    if (!isLive && previousTap.side === side && now - previousTap.timestamp <= DOUBLE_TAP_WINDOW_MS) {
      clearSingleToggleTimer();
      revealControls();
      handleDirectionalSeek(touchPoint.clientX, event.currentTarget);
      lastTapRef.current = { timestamp: 0, side: "" };
      resetTouchGesture();
      event.preventDefault();
      return;
    }

    lastTapRef.current = { timestamp: now, side };
    resetTouchGesture();
    event.preventDefault();
    scheduleControlsToggle();
  };

  const handleSurfaceTouchStartCapture = (event) => {
    if (!showVideoChrome) return;

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
    if (!showVideoChrome) return;

    const touchPoint = event.touches?.[0];
    if (!touchPoint) return;

    const deltaX = Math.abs(touchPoint.clientX - touchGestureRef.current.x);
    const deltaY = Math.abs(touchPoint.clientY - touchGestureRef.current.y);
    if (deltaX > TAP_MOVEMENT_THRESHOLD_PX || deltaY > TAP_MOVEMENT_THRESHOLD_PX) {
      touchGestureRef.current.moved = true;
    }
  };

  const handleSurfacePointerMove = (event) => {
    if (!hasVideoControls || event.pointerType === "touch") return;
    revealControls();
  };

  const handleSurfacePointerLeave = (event) => {
    if (!hasVideoControls || event.pointerType === "touch") return;
    hideControlsNow();
  };

  // Any interaction with the bar (tap, click, key) restarts the fade timer.
  const handleControlsInteraction = () => {
    revealControls();
  };

  // Keyboard users keep the bar while they tab through it; a mouse click or
  // tap that focuses a button must not stop the bar from fading.
  const handleControlsFocus = (event) => {
    if (!isKeyboardFocus(event.target)) return;
    controlsPinnedRef.current = true;
    revealControls({ autoHide: false });
  };

  const handleControlsBlur = (event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && typeof event.currentTarget?.contains === "function" && event.currentTarget.contains(nextTarget)) {
      return;
    }
    controlsPinnedRef.current = false;
    if (!videoPausedRef.current) scheduleControlsAutoHide();
  };

  const handleToggleFullscreen = async () => {
    try {
      const containerElement = containerRef.current;
      autoFullscreenRef.current = false;

      if (isAppFullscreen) {
        setIsAppFullscreen(false);
        revealControls();
        releaseOrientationLock();
        return;
      }
      if (getFullscreenElement() === containerElement) {
        await exitAnyFullscreen();
        releaseOrientationLock();
        return;
      }
      if (shouldUseAppFullscreen()) {
        setIsAppFullscreen(true);
        revealControls();
        orientationLockedRef.current = await lockLandscapeOrientation();
        return;
      }
      if (canFullscreen(containerElement)) {
        try {
          await requestElementFullscreen(containerElement);
          orientationLockedRef.current = await lockLandscapeOrientation();
          return;
        } catch {
          // Fall through to app fullscreen when the browser exposes the API
          // but rejects the request on this device/browser combination.
        }
      }
      setIsAppFullscreen(true);
      revealControls();
      orientationLockedRef.current = await lockLandscapeOrientation();
    } catch {
      // Best-effort enhancement only. Playback must remain usable if fullscreen fails.
    }
  };

  const playbackRateLabel = formatPlaybackRate(videoPlaybackRate);
  const FullscreenIcon = isImmersiveFullscreen ? Minimize : Maximize;
  const PlayPauseIcon = videoPaused ? PlayFilledAlt : PauseFilled;
  // Touch layout: play/back/forward sit in the middle while controls show.
  // Desktop layout: only the big play button, and only while paused.
  const centerVisible = showVideoChrome && (isTouchLayout ? shouldShowControls : videoPaused);

  return (
    <div
      ref={containerRef}
      data-protected-playback-surface="true"
      data-fullscreen={isImmersiveFullscreen ? "true" : "false"}
      data-app-fullscreen={isAppFullscreen ? "true" : "false"}
      data-controls-visible={shouldShowControls ? "true" : "false"}
      data-controls-layout={controlsLayout}
      data-live={isLive ? "true" : "false"}
      className={surfaceClassName}
      style={{ touchAction: hasVideoControls ? "manipulation" : undefined }}
      onPointerMove={handleSurfacePointerMove}
      onPointerLeave={handleSurfacePointerLeave}
    >
      <div data-protected-playback-content="true" className={stageClassName}>
        {children}
        {showVideoChrome ? (
          <div
            ref={gestureSurfaceRef}
            data-playback-gesture-surface="true"
            className="pps-gesture"
            onClickCapture={handleSurfaceClickCapture}
            onDoubleClickCapture={handleSurfaceDoubleClickCapture}
            onTouchStartCapture={handleSurfaceTouchStartCapture}
            onTouchMoveCapture={handleSurfaceTouchMoveCapture}
            onTouchEndCapture={handleSurfaceTouchEndCapture}
            onTouchCancelCapture={resetTouchGesture}
            aria-hidden="true"
          />
        ) : null}
        {showVideoChrome ? <div className="pps-scrim" aria-hidden="true" /> : null}
        <PlaybackWatermark enabled={watermarkEnabled} className={watermarkClassName} />
        {centerVisible ? (
          <div className="pps-center" data-playback-gesture-ignore="true" onClickCapture={handleControlsInteraction}>
            {isTouchLayout && !isLive ? (
              <ControlButton
                label={`Back ${VIDEO_SKIP_SECONDS} seconds`}
                icon={Rewind_10}
                iconSize={24}
                className="pps-btn--round"
                onClick={handleSkipBackward}
                disabled={!hasSeekableVideo}
              />
            ) : null}
            <ControlButton
              label={videoPaused ? "Play video" : "Pause video"}
              icon={PlayPauseIcon}
              iconSize={32}
              className="pps-btn--round pps-btn--primary"
              onClick={() => {
                clearSingleToggleTimer();
                void handleTogglePlayback();
              }}
            />
            {isTouchLayout && !isLive ? (
              <ControlButton
                label={`Forward ${VIDEO_SKIP_SECONDS} seconds`}
                icon={Forward_10}
                iconSize={24}
                className="pps-btn--round"
                onClick={handleSkipForward}
                disabled={!hasSeekableVideo}
              />
            ) : null}
          </div>
        ) : null}
        {!hasVideoControls && canUseFullscreenControl ? (
          <div data-playback-gesture-ignore="true" className="pps-corner">
            <ControlButton
              label={buttonLabel}
              icon={FullscreenIcon}
              className="pps-btn--overlay"
              data-playback-action="fullscreen"
              onClick={handleToggleFullscreen}
            />
          </div>
        ) : null}
        {showVideoChrome ? (
          <div
            className="pps-controls"
            data-playback-gesture-ignore="true"
            onClickCapture={handleControlsInteraction}
            onFocus={handleControlsFocus}
            onBlur={handleControlsBlur}
          >
            {!isLive ? (
              <div className="pps-progress">
                <input
                  type="range"
                  className="pps-seek"
                  min="0"
                  max={hasSeekableVideo ? videoDuration : 0}
                  step="0.1"
                  value={hasSeekableVideo ? Math.min(videoCurrentTime, videoDuration) : 0}
                  onChange={handleSeekChange}
                  disabled={!hasSeekableVideo}
                  aria-label="Seek through video"
                  aria-valuetext={formatSeekValueText(videoCurrentTime, videoDuration)}
                  style={{ "--pps-progress": `${progressPercent}%` }}
                />
              </div>
            ) : null}
            <div className="pps-bar">
              <div className="pps-bar__group">
                {!isTouchLayout ? (
                  <ControlButton label={playPauseLabel} icon={PlayPauseIcon} onClick={() => void handleTogglePlayback()} />
                ) : null}
                {!isTouchLayout && !isLive ? (
                  <>
                    <ControlButton
                      label={`Back ${VIDEO_SKIP_SECONDS} seconds`}
                      icon={Rewind_10}
                      onClick={handleSkipBackward}
                      disabled={!hasSeekableVideo}
                    />
                    <ControlButton
                      label={`Forward ${VIDEO_SKIP_SECONDS} seconds`}
                      icon={Forward_10}
                      onClick={handleSkipForward}
                      disabled={!hasSeekableVideo}
                    />
                  </>
                ) : null}
                <ControlButton
                  label={muteLabel}
                  icon={videoMuted ? VolumeMuteFilled : VolumeUpFilled}
                  onClick={handleToggleMute}
                />
                {isLive ? (
                  <span className="pps-live">
                    <span className="pps-live__dot" aria-hidden="true" />
                    Live
                  </span>
                ) : (
                  <span className="pps-time">
                    {formatPlaybackTime(videoCurrentTime)}
                    <span className="pps-time__total"> / {formatPlaybackTime(videoDuration)}</span>
                  </span>
                )}
              </div>
              <div className="pps-bar__group pps-bar__group--end">
                {canChangePlaybackRate ? (
                  <button
                    type="button"
                    className="pps-btn pps-btn--text"
                    onClick={handleCyclePlaybackRate}
                    aria-label={`Playback speed ${playbackRateLabel}. Change speed`}
                  >
                    {playbackRateLabel}
                  </button>
                ) : null}
                {canSelectQuality ? (
                  <div ref={qualityMenuRef} className="pps-menu-anchor">
                    <button
                      type="button"
                      className="pps-btn pps-btn--quality"
                      onClick={() => setQualityMenuOpen((current) => !current)}
                      aria-haspopup="menu"
                      aria-expanded={qualityMenuOpen ? "true" : "false"}
                      aria-label={`Quality: ${qualityButtonLabel}`}
                    >
                      <Settings size={20} aria-hidden="true" />
                      <span className="pps-btn__text">{qualityButtonLabel}</span>
                    </button>
                    {qualityMenuOpen ? (
                      <div role="menu" aria-label="Quality" className="pps-menu">
                        <div className="pps-menu__title" aria-hidden="true">
                          Quality
                        </div>
                        {qualityOptions.map((option) => {
                          const isActive = selectedQuality === option.value;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isActive ? "true" : "false"}
                              className="pps-menu__item"
                              onClick={() => {
                                onQualityChange(option.value);
                                setQualityMenuOpen(false);
                              }}
                            >
                              <span className="pps-menu__check" aria-hidden="true">
                                {isActive ? <Checkmark size={16} /> : null}
                              </span>
                              <span>{option.label}</span>
                            </button>
                          );
                        })}
                        {qualityControlMessage ? <p className="pps-menu__note">{qualityControlMessage}</p> : null}
                      </div>
                    ) : null}
                  </div>
                ) : shouldShowQualityBadge ? (
                  <span className="pps-badge">
                    <span className="pps-visually-hidden">Playback quality: </span>
                    {activeQualityLabel}
                  </span>
                ) : null}
                {canUseFullscreenControl ? (
                  <ControlButton
                    label={buttonLabel}
                    icon={FullscreenIcon}
                    data-playback-action="fullscreen"
                    onClick={handleToggleFullscreen}
                  />
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
