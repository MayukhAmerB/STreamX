// Syed Carbon motion helpers (UI overhaul plan §2.2-§2.4). OWNER: WS-A.
// About 2 KB gzipped, no dependencies: rAF count-ups, WAAPI FLIP, View
// Transitions and IntersectionObserver. Every helper renders the final state
// under reduced motion (OS setting or `data-motion="reduce"` on <html>), and
// nothing runs while the tab is hidden.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";
// Same key and event as the shell's avatar-menu toggle (app-shell/motionPreference.js).
const MOTION_STORAGE_KEY = "sc.motion";
const MOTION_CHANGE_EVENT = "sc:motion-change";
const COUNTED_STORAGE_KEY = "sc-counted";

const hasWindow = () => typeof window !== "undefined" && typeof document !== "undefined";
const useIsoLayoutEffect = hasWindow() ? useLayoutEffect : useEffect;

/** True when the OS or the Profile toggle asks for reduced motion (false outside a browser). */
export function prefersReducedMotionNow() {
  if (!hasWindow()) return false;
  if (document.documentElement?.dataset?.motion === "reduce") return true;
  return window.matchMedia?.(REDUCE_QUERY)?.matches === true;
}

function subscribeReduced(callback) {
  if (!hasWindow()) return () => {};
  const query = window.matchMedia?.(REDUCE_QUERY);
  query?.addEventListener?.("change", callback);
  let observer = null;
  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(callback);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  }
  return () => {
    query?.removeEventListener?.("change", callback);
    observer?.disconnect();
  };
}

/** True when the OS or the Profile toggle (`data-motion="reduce"`) asks for reduced motion. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribeReduced, prefersReducedMotionNow, () => false);
}

/**
 * Profile "Reduce motion" (WCAG 2.3.3): `"reduce"` sets `data-motion="reduce"`
 * on <html> and remembers it on this device; `"auto"` follows the OS again.
 */
export function setMotionPreference(preference) {
  if (!hasWindow()) return;
  const reduce = preference === "reduce";
  if (reduce) document.documentElement.dataset.motion = "reduce";
  else delete document.documentElement.dataset.motion;
  try {
    if (reduce) window.localStorage.setItem(MOTION_STORAGE_KEY, "reduce");
    else window.localStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
  if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(MOTION_CHANGE_EVENT, { detail: { reduced: reduce } }));
  }
}

/** The stored Profile choice: `"reduce"` or `"auto"`. */
export function getMotionPreference() {
  if (!hasWindow()) return "auto";
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY) === "reduce" ? "reduce" : "auto";
  } catch {
    return document.documentElement?.dataset?.motion === "reduce" ? "reduce" : "auto";
  }
}

/** Applies the stored Profile choice once at boot (called by the kit's entry module). */
export function initMotionPreference() {
  if (hasWindow() && getMotionPreference() === "reduce") document.documentElement.dataset.motion = "reduce";
}

/** `[ref, seen]`: `seen` turns true the first time the element is in view, then stays true. */
export function useInViewOnce({ rootMargin = "0px", threshold = 0.5, enabled = true } = {}) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (seen || !enabled || !node) return undefined;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin, threshold }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, enabled, rootMargin, threshold]);
  return [ref, seen];
}

// ------------------------------------------------------------ M5 count-up

const countedThisSession = new Set();

function alreadyCounted(key) {
  if (!key) return false;
  if (countedThisSession.has(key)) return true;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(COUNTED_STORAGE_KEY) || "[]");
    return Array.isArray(stored) && stored.includes(key);
  } catch {
    return false;
  }
}

function rememberCounted(key) {
  if (!key) return;
  countedThisSession.add(key);
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(COUNTED_STORAGE_KEY) || "[]");
    const next = Array.isArray(stored) ? stored : [];
    if (!next.includes(key)) next.push(key);
    window.sessionStorage.setItem(COUNTED_STORAGE_KEY, JSON.stringify(next.slice(-200)));
  } catch {
    // Storage blocked: the in-memory set still stops replays in this tab.
  }
}

/** Test hook: forget which count-ups ran this session. */
export function resetCountUpMemory() {
  countedThisSession.clear();
  try {
    window.sessionStorage.removeItem(COUNTED_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// entrance-expressive is close to an ease-out cubic.
const easeOut = (t) => 1 - (1 - t) ** 3;

/**
 * The number to show for a count-up (M5): 0 → `value` over 700 ms the first
 * time `start` is true (once per `sessionKey` per session, D6), then tweens
 * from the previous value on updates. Final value at once under reduced
 * motion, for non-numbers, and when the tab is hidden (the rAF loop aborts on
 * `visibilitychange`).
 */
export function useCountUp(value, { start = true, duration = 700, sessionKey } = {}) {
  const numeric = typeof value === "number" && Number.isFinite(value);
  const [display, setDisplay] = useState(() => (numeric && !alreadyCounted(sessionKey) && !prefersReducedMotionNow() ? 0 : value));
  const shown = useRef(display);
  const ran = useRef(false);

  useEffect(() => {
    if (!numeric) {
      shown.current = value;
      setDisplay(value);
      return undefined;
    }
    if (!start) return undefined;
    const first = !ran.current;
    ran.current = true;
    const from = first ? (alreadyCounted(sessionKey) ? value : 0) : Number(shown.current) || 0;
    if (prefersReducedMotionNow() || (typeof document !== "undefined" && document.hidden) || from === value || typeof requestAnimationFrame === "undefined") {
      shown.current = value;
      setDisplay(value);
      if (first) rememberCounted(sessionKey);
      return undefined;
    }
    const integer = Number.isInteger(value) && Number.isInteger(from);
    let frame = 0;
    let begin = null;
    const finish = () => {
      cancelAnimationFrame(frame);
      shown.current = value;
      setDisplay(value);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const onVisibility = () => {
      if (document.hidden) finish();
    };
    const step = (now) => {
      if (begin === null) begin = now;
      const t = Math.min(1, (now - begin) / duration);
      const current = from + (value - from) * easeOut(t);
      const next = t >= 1 ? value : integer ? Math.round(current) : Math.round(current * 10) / 10;
      shown.current = next;
      setDisplay(next);
      if (t < 1) frame = requestAnimationFrame(step);
      else document.removeEventListener("visibilitychange", onVisibility);
    };
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(step);
    if (first) rememberCounted(sessionKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [value, numeric, start, duration, sessionKey]);

  return numeric ? display : value;
}

// --------------------------------------------------------------- M2 stagger

/**
 * Staggered entrance on the FIRST data render only (M2/M2b). Spread
 * `enter(i)` on each item: during the first render after `ready` turns true,
 * items get their index (capped by --sc-stagger-max in CSS); anything that
 * mounts later enters at once (i = 0); nothing replays on refetch or sort.
 */
export function useStagger(ready = true, { variant } = {}) {
  const [phase, setPhase] = useState(ready ? "first" : "waiting");
  useEffect(() => {
    if (ready && phase === "waiting") setPhase("first");
    if (phase !== "first") return undefined;
    const timer = setTimeout(() => setPhase("done"), 600);
    return () => clearTimeout(timer);
  }, [ready, phase]);
  return useCallback(
    (index = 0) => ({
      "data-sc-enter": variant === "site" ? "site" : "",
      style: { "--sc-i": phase === "first" ? Math.max(0, index) : 0 },
    }),
    [phase, variant]
  );
}

// ------------------------------------------------------------------ FLIP

/**
 * FLIP for list changes (M10 toasts, M21 rows): call `capture()` right before
 * a state change; children of `ref` with `data-flip-key` that moved slide from
 * their old place with a transform (WAAPI, moderate-01). No-op under reduced
 * motion or without WAAPI.
 */
export function useFlip({ duration = 150, easing = "cubic-bezier(0, 0, 0.38, 0.9)" } = {}) {
  const ref = useRef(null);
  const snapshot = useRef(null);

  const capture = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const rects = new Map();
    root.querySelectorAll("[data-flip-key]").forEach((node) => rects.set(node.dataset.flipKey, node.getBoundingClientRect()));
    snapshot.current = rects;
  }, []);

  useIsoLayoutEffect(() => {
    const previous = snapshot.current;
    const root = ref.current;
    snapshot.current = null;
    if (!previous || !root || prefersReducedMotionNow()) return;
    root.querySelectorAll("[data-flip-key]").forEach((node) => {
      const before = previous.get(node.dataset.flipKey);
      if (!before || typeof node.animate !== "function") return;
      const after = node.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (!dx && !dy) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration, easing });
    });
  });

  return { ref, capture };
}

// ------------------------------------------------------- M1 route changes

/**
 * Navigates with a View Transition when the browser supports it (M1): only
 * <main> (view-transition-name: sc-main) crossfades and rises 8 px; the shell
 * holds still. Falls back to plain navigation (the shell's M1c fade covers it)
 * and to a 100 ms crossfade under reduced motion (CSS). `navigate` is
 * react-router's `useNavigate()` result.
 */
export function navigateWithTransition(navigate, to, options = {}) {
  const go = () => navigate(to, options);
  if (!hasWindow() || typeof document.startViewTransition !== "function" || document.hidden) return go();
  try {
    document.startViewTransition(() => {
      flushSync(go);
    });
  } catch {
    go();
  }
  return undefined;
}
