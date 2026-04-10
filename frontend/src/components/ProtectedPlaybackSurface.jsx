import { useEffect, useMemo, useRef, useState } from "react";
import PlaybackWatermark from "./PlaybackWatermark";
import {
  isNestedFullscreenTarget,
  normalizeProtectedPlaybackClassName,
} from "../utils/protectedPlayback";

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

export default function ProtectedPlaybackSurface({
  children,
  watermarkEnabled = true,
  className = "",
  showFullscreenButton = true,
  watermarkClassName = "",
  fullscreenLabel = "Fullscreen",
}) {
  const containerRef = useRef(null);
  const orientationLockedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);

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
      {showFullscreenButton && fullscreenSupported ? (
        <div className="pointer-events-none absolute right-3 top-3 z-20">
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
