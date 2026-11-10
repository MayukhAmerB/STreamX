import { useEffect, useRef } from "react";
import { resolvePlayerShortcut } from "./playerShortcuts";

export function clickFullscreenButton(container) {
  // The player's fullscreen control is an icon button marked with
  // data-playback-action; older markup is matched by its label text.
  const marked = container?.querySelector?.(
    "[data-protected-playback-surface] [data-playback-action='fullscreen']"
  );
  if (marked) {
    marked.click();
    return;
  }
  const buttons = container?.querySelectorAll?.("[data-protected-playback-surface] button") || [];
  const button = [...buttons].find((candidate) =>
    /full|exit/i.test(`${candidate.getAttribute?.("aria-label") || ""} ${candidate.textContent || ""}`)
  );
  button?.click();
}

/**
 * Document-level YouTube-style shortcuts for the lecture video. Ignored while
 * typing (comments, notes) and when a widget owns the key (tabs, slider).
 */
export function usePlayerShortcuts({ videoRef, containerRef, onNext, onPrevious, enabled = true }) {
  const handlersRef = useRef({ onNext, onPrevious });
  handlersRef.current = { onNext, onPrevious };

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return undefined;

    const handleKeyDown = (event) => {
      const shortcut = resolvePlayerShortcut(event);
      if (!shortcut) return;
      const video = videoRef.current;

      switch (shortcut.action) {
        case "next":
          event.preventDefault();
          handlersRef.current.onNext?.();
          return;
        case "previous":
          event.preventDefault();
          handlersRef.current.onPrevious?.();
          return;
        case "fullscreen":
          if (!video) return;
          event.preventDefault();
          clickFullscreenButton(containerRef.current);
          return;
        default:
          break;
      }

      if (!video) return;
      event.preventDefault();
      if (shortcut.action === "toggle-play") {
        if (video.paused) {
          const attempt = video.play?.();
          if (attempt && typeof attempt.catch === "function") attempt.catch(() => {});
        } else {
          video.pause();
        }
      } else if (shortcut.action === "seek") {
        const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
        video.currentTime = Math.min(duration, Math.max(0, (video.currentTime || 0) + shortcut.seconds));
      } else if (shortcut.action === "mute") {
        video.muted = !video.muted;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [videoRef, containerRef, enabled]);
}
