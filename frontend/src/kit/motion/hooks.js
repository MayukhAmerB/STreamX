// Reduced-motion, in-view and typewriter hooks (no motion dependency). OWNER: WS-KIT.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export const REVEAL_MS = 320;
export const REVEAL_EASE = [0.2, 0.8, 0.2, 1];
export const STAGGER_MS = 60;
export const STAGGER_MAX = 6;

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * True when the viewer asked for reduced motion, or when there is no window
 * (server render, tests): the final state is always the safe default.
 */
export function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  if (typeof document !== "undefined" && document.documentElement?.dataset?.motion === "reduce") return true;
  return window.matchMedia(QUERY).matches;
}

function subscribe(callback) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener?.("change", callback);
  return () => list.removeEventListener?.("change", callback);
}

/** Live reduced-motion preference (re-renders when the OS setting changes). */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => true);
}

/**
 * Becomes true the first time the element enters the viewport, then stops
 * observing. Without IntersectionObserver it is true at once (final state).
 */
export function useInViewOnce(ref, { rootMargin = "0px 0px -10% 0px", threshold = 0.15 } = {}) {
  const [inView, setInView] = useState(() => typeof window === "undefined" || typeof window.IntersectionObserver !== "function");
  useEffect(() => {
    if (inView) return undefined;
    const node = ref.current;
    if (!node || typeof window.IntersectionObserver !== "function") {
      setInView(true);
      return undefined;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin, threshold }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView, ref, rootMargin, threshold]);
  return inView;
}

/**
 * Types `lines` (array of strings) one character at a time once `start` is
 * true (M13/M14): `speed` ms per character, the whole run capped at `maxMs`
 * (the per-character delay shrinks for long text). Reduced motion returns
 * every line in full at once.
 * Returns { lines: string[], done: boolean }.
 */
export function useTypewriter(lines, { start = true, speed = 18, maxMs = 2500 } = {}) {
  const reduced = useReducedMotion();
  const source = Array.isArray(lines) ? lines : [String(lines ?? "")];
  const total = source.reduce((sum, line) => sum + line.length, 0);
  const [count, setCount] = useState(0);
  const key = source.join("\n");
  const keyRef = useRef(key);

  useEffect(() => {
    if (keyRef.current !== key) {
      keyRef.current = key;
      setCount(0);
    }
  }, [key]);

  useEffect(() => {
    if (reduced || !start || count >= total) return undefined;
    const step = Math.max(4, Math.min(speed, Math.floor(maxMs / Math.max(1, total))));
    const timer = setTimeout(() => setCount((value) => Math.min(total, value + 1)), step);
    return () => clearTimeout(timer);
  }, [reduced, start, count, total, speed, maxMs]);

  if (reduced) return { lines: source, done: true };
  let left = count;
  const shown = source.map((line) => {
    const part = line.slice(0, Math.max(0, left));
    left -= line.length;
    return part;
  });
  return { lines: shown, done: count >= total };
}
