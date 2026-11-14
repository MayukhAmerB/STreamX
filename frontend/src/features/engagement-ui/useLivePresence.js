// Live-class presence ping for live-attendance XP. OWNER: WS-LEARN.
// Contract (engagement-notes.md §9): while a live class page is open AND
// visible, POST /api/engagement/live/<session_id>/presence/ once every 60 s,
// never more often (the server credits by wall clock and rate-limits at
// 12/min). Nothing is sent while the `engagement` switch is off, and a 403
// feature_disabled stops the pings until the page is opened again.
import { useEffect } from "react";
import { isEngagementDisabledError, postLivePresence } from "./engagementApi";
import { useEngagementEnabled } from "./useEngagement";

export const PRESENCE_INTERVAL_MS = 60_000;

/**
 * Framework-free loop (tests drive it): returns a stop function.
 * `deps`: { post(sessionId), doc, win, now }.
 */
export function startPresenceLoop(sessionId, deps = {}) {
  const post = deps.post || postLivePresence;
  const doc = deps.doc !== undefined ? deps.doc : typeof document !== "undefined" ? document : null;
  const win = deps.win !== undefined ? deps.win : typeof window !== "undefined" ? window : null;
  const now = deps.now || (() => Date.now());
  if (!sessionId || !win?.setInterval) return () => {};
  let last = null;
  let stopped = false;
  const visible = () => !doc || doc.visibilityState !== "hidden";
  const ping = () => {
    if (stopped || !visible()) return;
    // A visibility flip never makes it faster than once a minute.
    if (last !== null && now() - last < PRESENCE_INTERVAL_MS - 1000) return;
    last = now();
    Promise.resolve(post(sessionId)).catch((error) => {
      if (isEngagementDisabledError(error)) stop();
    });
  };
  const onVisibility = () => ping();
  const timer = win.setInterval(ping, PRESENCE_INTERVAL_MS);
  doc?.addEventListener?.("visibilitychange", onVisibility);
  ping();
  function stop() {
    if (stopped) return;
    stopped = true;
    win.clearInterval(timer);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
  }
  return stop;
}

/** Pings while `sessionId` is set, the page is visible and engagement is on. */
export default function useLivePresence(sessionId) {
  const enabled = useEngagementEnabled();
  useEffect(() => {
    if (!enabled || !sessionId) return undefined;
    return startPresenceLoop(sessionId);
  }, [enabled, sessionId]);
}
