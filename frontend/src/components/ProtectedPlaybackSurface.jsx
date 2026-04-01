import { useEffect, useMemo, useRef, useState } from "react";
import PlaybackWatermark from "./PlaybackWatermark";
import { isNestedFullscreenTarget } from "../utils/protectedPlayback";

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);

  useEffect(() => {
    setFullscreenSupported(canFullscreen(containerRef.current));

    const syncFullscreenState = () => {
      const fullscreenElement = getFullscreenElement();
      const container = containerRef.current;

      if (isNestedFullscreenTarget(container, fullscreenElement)) {
        setIsFullscreen(false);
        void exitAnyFullscreen();
        return;
      }

      setIsFullscreen(fullscreenElement === container);
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

  const handleToggleFullscreen = async () => {
    try {
      if (getFullscreenElement() === containerRef.current) {
        await exitAnyFullscreen();
        return;
      }
      await requestElementFullscreen(containerRef.current);
    } catch {
      // Best-effort enhancement only. Playback must remain usable if fullscreen fails.
    }
  };

  return (
    <div
      ref={containerRef}
      data-protected-playback-surface="true"
      className={`relative overflow-hidden bg-black ${isFullscreen ? "h-full w-full" : ""} ${className}`.trim()}
    >
      {children}
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
