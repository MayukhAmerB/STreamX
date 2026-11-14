// "A class is playing on this device" registry (Phase 2, D5).
//
// When a newer sign-in elsewhere evicts this device, the app used to open a
// blocking dialog (or bounce to /login). While a live class is playing here,
// the student instead finishes the class with a banner; the dialog appears
// once the class is over. Players register while they are mounted.
import { useSyncExternalStore } from "react";

const active = new Map();
const listeners = new Set();
let nextToken = 1;

function emit() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // a broken listener must not break the others
    }
  });
}

/** Register a playing class; returns the unregister function. */
export function registerLiveClassPlayback(label = "live-class") {
  const token = nextToken;
  nextToken += 1;
  active.set(token, String(label));
  emit();
  return () => {
    if (active.delete(token)) emit();
  };
}

export function isLiveClassActive() {
  return active.size > 0;
}

export function subscribeLiveClassGuard(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveClassActive() {
  return useSyncExternalStore(subscribeLiveClassGuard, isLiveClassActive, isLiveClassActive);
}

/** Test helper. */
export function resetLiveClassGuard() {
  active.clear();
  emit();
}
