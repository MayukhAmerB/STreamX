import { useSyncExternalStore } from "react";
import { describeBreakpoint, getBreakpoint } from "./breakpoints";

const SERVER_BREAKPOINT = "lg";

function subscribeToResize(callback) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", callback);
  window.addEventListener("orientationchange", callback);
  return () => {
    window.removeEventListener("resize", callback);
    window.removeEventListener("orientationchange", callback);
  };
}

function readBreakpoint() {
  if (typeof window === "undefined") return SERVER_BREAKPOINT;
  const width = document.documentElement?.clientWidth || window.innerWidth;
  return getBreakpoint(width);
}

/**
 * Current Carbon breakpoint plus layout flags. Re-renders only when the
 * breakpoint name changes (the snapshot is a string), not on every resize.
 */
export function useBreakpoint() {
  const name = useSyncExternalStore(subscribeToResize, readBreakpoint, () => SERVER_BREAKPOINT);
  return describeBreakpoint(name);
}

/** Generic media query hook, e.g. useMediaQuery("(prefers-reduced-motion: reduce)"). */
export function useMediaQuery(query, serverValue = false) {
  return useSyncExternalStore(
    (callback) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", callback);
      return () => list.removeEventListener("change", callback);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : serverValue),
    () => serverValue
  );
}
