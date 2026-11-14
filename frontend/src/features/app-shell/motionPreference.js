// "Reduce motion" preference (plan §1.7, WCAG 2.3.3): the viewer's own
// choice on top of the OS setting. OWNER: WS-B. Stored per browser (a
// per-viewer convenience), applied as `<html data-motion="reduce">`, which
// the Syed Carbon motion tokens and useReducedMotion() read. The avatar menu
// and the Profile page (WS-C) both use this module so they stay in sync.
import { useCallback, useSyncExternalStore } from "react";

export const MOTION_STORAGE_KEY = "sc.motion";
export const MOTION_CHANGE_EVENT = "sc:motion-change";

function storage(store) {
  return store === undefined ? globalThis.localStorage : store;
}

/** True when this browser asked for reduced motion. Storage may be blocked. */
export function readMotionReduced(store) {
  try {
    return storage(store)?.getItem(MOTION_STORAGE_KEY) === "reduce";
  } catch {
    return false;
  }
}

/** Sets `data-motion` on the root element (or removes it). */
export function applyMotionPreference(reduced = readMotionReduced(), root = globalThis.document?.documentElement) {
  if (!root) return;
  if (reduced) root.setAttribute("data-motion", "reduce");
  else root.removeAttribute("data-motion");
}

export function setMotionReduced(reduced, store) {
  try {
    const target = storage(store);
    if (reduced) target?.setItem(MOTION_STORAGE_KEY, "reduce");
    else target?.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: applies for this visit only.
  }
  applyMotionPreference(Boolean(reduced));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MOTION_CHANGE_EVENT, { detail: { reduced: Boolean(reduced) } }));
  }
}

function subscribe(callback) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MOTION_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(MOTION_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function snapshot() {
  if (typeof document === "undefined") return false;
  return document.documentElement?.getAttribute("data-motion") === "reduce" || readMotionReduced();
}

/** `[reduced, setReduced]` for a toggle. */
export function useMotionPreference() {
  const reduced = useSyncExternalStore(subscribe, snapshot, () => false);
  const setReduced = useCallback((value) => setMotionReduced(Boolean(value)), []);
  return [reduced, setReduced];
}
