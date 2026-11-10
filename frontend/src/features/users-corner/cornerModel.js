// Pure helpers for the Console hub (no React, no DOM).
import { getCourseProgress } from "../../utils/courseProgress";
import { findJoinableLiveSession, resolveLiveClassSchedule } from "../../utils/liveClassSchedule";
import { sortLiveSessions } from "../live-classes/liveSessions";

/** How many owned courses the hub previews before "View all". */
export const CORNER_COURSE_PREVIEW_LIMIT = 3;

/** "Asha" from "Asha Rao" (falls back to the e-mail name, else ""). */
export function getFirstName(user) {
  const fullName = String(user?.full_name || "").trim();
  if (fullName) return fullName.split(/\s+/)[0];
  const emailName = String(user?.email || "").split("@")[0].trim();
  if (!emailName) return "";
  const firstPart = emailName.split(/[._-]+/).find(Boolean) || "";
  return firstPart ? firstPart.charAt(0).toUpperCase() + firstPart.slice(1) : "";
}

export function getCornerGreeting(user) {
  const firstName = getFirstName(user);
  return firstName ? `Welcome back, ${firstName}` : "Welcome back";
}

/**
 * The course for the "Continue learning" card: the last course opened in
 * the player (if the user still owns it), else the furthest course in
 * progress, else the first one not finished, else the first course.
 */
export function pickContinueCourse(courses = [], lastCourseId = "") {
  const list = Array.isArray(courses) ? courses.filter((course) => course && course.id) : [];
  if (list.length === 0) return null;
  const lastId = String(lastCourseId ?? "").trim();
  if (lastId) {
    const last = list.find((course) => String(course.id) === lastId);
    if (last) return last;
  }
  const inProgress = list
    .filter((course) => getCourseProgress(course).status === "in-progress")
    .sort((a, b) => getCourseProgress(b).percent - getCourseProgress(a).percent);
  if (inProgress.length > 0) return inProgress[0];
  return list.find((course) => getCourseProgress(course).status !== "completed") || list[0];
}

/** First few courses for the hub, the "Continue learning" course first. */
export function getCoursePreview(courses = [], continueCourse = null, limit = CORNER_COURSE_PREVIEW_LIMIT) {
  const list = Array.isArray(courses) ? courses.filter((course) => course && course.id) : [];
  if (!continueCourse) return list.slice(0, limit);
  return [continueCourse, ...list.filter((course) => course.id !== continueCourse.id)].slice(0, limit);
}

/**
 * Live card state from the realtime session list: the joinable live class
 * (if any) and the weekly schedule for "Next live class".
 */
export function getLiveSummary(sessions = []) {
  const ordered = sortLiveSessions(Array.isArray(sessions) ? sessions : []);
  return {
    liveSession: findJoinableLiveSession(ordered),
    schedule: resolveLiveClassSchedule(ordered),
  };
}

/** Where "Join class" goes: the live page, which joins the shared session. */
export function getLiveJoinPath(session) {
  const id = Number(session?.id || 0);
  return Number.isInteger(id) && id > 0 ? `/join-live?session=${id}` : "/join-live";
}

/** Course counts for the hub hero: total, in progress, completed. */
export function getStudentStats(courses = []) {
  const list = Array.isArray(courses) ? courses.filter(Boolean) : [];
  const statuses = list.map((course) => getCourseProgress(course).status);
  return {
    total: list.length,
    inProgress: statuses.filter((status) => status === "in-progress").length,
    completed: statuses.filter((status) => status === "completed").length,
  };
}

/**
 * "Tuesday, 10 November" for the greeting band. `timeZone` is optional
 * (the viewer's own zone by default); returns "" if the date is invalid.
 */
export function formatHubDate(now = new Date(), { locale = "en-GB", timeZone } = {}) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone }).format(date);
  } catch {
    return "";
  }
}

const MINUTE_MS = 60_000;

/**
 * Time left until `start`, rounded up to the minute (a class 30 seconds
 * away still reads "1 min"). `null` when there is no valid start; `soon`
 * once it is under a minute away or has started.
 */
export function getCountdown(start, now = new Date()) {
  const target = start instanceof Date ? start : new Date(start ?? NaN);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(target.getTime()) || Number.isNaN(current.getTime())) return null;
  const remaining = target.getTime() - current.getTime();
  if (remaining <= 0) return { days: 0, hours: 0, minutes: 0, totalMs: 0, soon: true };
  const totalMinutes = Math.ceil(remaining / MINUTE_MS);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return { days, hours, minutes, totalMs: remaining, soon: remaining < MINUTE_MS };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "Starts in 2 days, 4 hours" / "Starts in 3 hours, 20 minutes" / "Starting now". */
export function formatCountdown(countdown) {
  if (!countdown) return "";
  if (countdown.soon) return "Starting now";
  const { days, hours, minutes } = countdown;
  if (days > 0) return `Starts in ${plural(days, "day")}${hours ? `, ${plural(hours, "hour")}` : ""}`;
  if (hours > 0) return `Starts in ${plural(hours, "hour")}${minutes ? `, ${plural(minutes, "minute")}` : ""}`;
  return `Starts in ${plural(minutes, "minute")}`;
}

/** Visual countdown segments: the two most significant non-zero units. */
export function getCountdownSegments(countdown) {
  if (!countdown || countdown.soon) return [];
  const { days, hours, minutes } = countdown;
  if (days > 0) return [{ value: days, unit: "d" }, { value: hours, unit: "h" }];
  if (hours > 0) return [{ value: hours, unit: "h" }, { value: minutes, unit: "m" }];
  return [{ value: minutes, unit: "m" }];
}

/** Average course progress (0-100, rounded), or 0 for an empty library. */
export function getAverageProgress(courses = []) {
  const list = Array.isArray(courses) ? courses.filter(Boolean) : [];
  if (list.length === 0) return 0;
  const sum = list.reduce((total, course) => total + getCourseProgress(course).percent, 0);
  return Math.round(sum / list.length);
}
