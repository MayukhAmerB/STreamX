// Live-class attendance ping. OWNER: WS-ATTENDANCE.
// Contract: while a live class page is open AND visible, POST
// /api/attendance/sessions/<id>/presence/ once every 60 s (never more often:
// the server credits by wall clock and rate-limits at 12/min). Leaving the
// page (unmount or pagehide) posts /leave/ once, which stops the clock.
// A 403 feature_disabled stops the loop until the page is opened again.
// Recordings never call this: only live presence counts as attendance.
import { useEffect } from "react";

import { isAttendanceDisabledError, postLeave, postPresence } from "./attendanceApi";

export const ATTENDANCE_PING_MS = 60_000;

/**
 * Framework-free loop (tests drive it); returns a stop function.
 * `deps`: { post(sessionId), leave(sessionId), doc, win, now }.
 */
export function startAttendancePresence(sessionId, deps = {}) {
  const post = deps.post || postPresence;
  const leave = deps.leave || postLeave;
  const doc = deps.doc !== undefined ? deps.doc : typeof document !== "undefined" ? document : null;
  const win = deps.win !== undefined ? deps.win : typeof window !== "undefined" ? window : null;
  const now = deps.now || (() => Date.now());
  if (!sessionId || !win?.setInterval) return () => {};
  let last = null;
  let stopped = false;
  let left = false;
  const visible = () => !doc || doc.visibilityState !== "hidden";
  const ping = () => {
    if (stopped || !visible()) return;
    if (last !== null && now() - last < ATTENDANCE_PING_MS - 1000) return;
    last = now();
    Promise.resolve()
      .then(() => post(sessionId))
      .catch((error) => {
        if (isAttendanceDisabledError(error)) stop({ silent: true });
      });
  };
  const sendLeave = () => {
    if (left) return;
    left = true;
    Promise.resolve()
      .then(() => leave(sessionId))
      .catch(() => {});
  };
  const onVisibility = () => ping();
  const onPageHide = () => sendLeave();
  const timer = win.setInterval(ping, ATTENDANCE_PING_MS);
  doc?.addEventListener?.("visibilitychange", onVisibility);
  win.addEventListener?.("pagehide", onPageHide);
  ping();

  function stop({ silent = false } = {}) {
    if (stopped) return;
    stopped = true;
    win.clearInterval(timer);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    win.removeEventListener?.("pagehide", onPageHide);
    if (!silent) sendLeave();
  }
  return () => stop();
}

/** Pings while `sessionId` is set (the live class page is open). */
export default function useAttendancePresence(sessionId) {
  useEffect(() => {
    if (!sessionId) return undefined;
    return startAttendancePresence(sessionId);
  }, [sessionId]);
}
