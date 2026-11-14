// Pure helpers for Console Home and Teach > Today (no React, no DOM).
// OWNER: WS-C. Data comes from GET /api/console/today/ (plan Appendix A.2).
import { getCountdown } from "../users-corner/cornerModel";

export { formatHubDate, getCornerGreeting } from "../users-corner/cornerModel";

export const DISPLAY_TIME_ZONE = "Asia/Kolkata";

/** Eyebrow line of the Next up card for each kind (server priority order). */
export const NEXT_UP_EYEBROW = Object.freeze({
  live_now: "Live now",
  exam_open: "Exam open",
  report_due: "Report due",
  resume: "Continue learning",
  next_class: "Next live class",
  browse: "Get started",
});

/** Icon name per kind (resolved to a Carbon icon by the view). */
export const KIND_ICON = Object.freeze({
  live_now: "video",
  exam_open: "flag",
  report_due: "report",
  resume: "play",
  next_class: "calendar",
  browse: "education",
});

/** Absolute http(s) links (labs) open in a new tab; app paths use the router. */
export function isExternalHref(href) {
  return /^https?:\/\//i.test(String(href || ""));
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/**
 * "Today 7:00 pm", "Tomorrow 11:59 pm" or "Sun 15 Nov, 11:59 pm" in IST
 * (the academy's time zone, as on every report and class). "" when invalid.
 */
export function formatWhen(value, now = new Date(), { timeZone = DISPLAY_TIME_ZONE } = {}) {
  const date = toDate(value);
  const current = toDate(now) || new Date();
  if (!date) return "";
  try {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
      .format(date)
      .replace(/\s?([ap])\.?m\.?$/i, (_m, p) => ` ${p.toLowerCase()}m`);
    const today = dayKey(current, timeZone);
    const tomorrow = dayKey(new Date(current.getTime() + 86_400_000), timeZone);
    const key = dayKey(date, timeZone);
    if (key === today) return `Today ${time}`;
    if (key === tomorrow) return `Tomorrow ${time}`;
    const day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" })
      .format(date)
      .replace(",", "");
    return `${day}, ${time}`;
  } catch {
    return "";
  }
}

/** Meta text for an "Also this week" row. */
export function formatAlsoMeta(row, now = new Date()) {
  const when = formatWhen(row?.due_at, now);
  if (!when) return "";
  if (row.kind === "next_class") return when;
  if (row.kind === "live_now") return "Live now";
  if (row.kind === "exam_open") return `Closes ${when}`;
  return `Due ${when}`;
}

/** Countdown segments for "Opens in 2 d 04 h" (null when not in the future). */
export function getStartsIn(startsAt, now = new Date()) {
  const countdown = getCountdown(startsAt, now);
  if (!countdown || countdown.soon) return null;
  const pad = (value) => String(value).padStart(2, "0");
  const { days, hours, minutes } = countdown;
  const segments =
    days > 0
      ? [
          { value: String(days), unit: "d" },
          { value: pad(hours), unit: "h" },
        ]
      : [
          { value: pad(hours), unit: "h" },
          { value: pad(minutes), unit: "m" },
        ];
  const spoken =
    days > 0
      ? `${days} day${days === 1 ? "" : "s"} ${hours} hour${hours === 1 ? "" : "s"}`
      : `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return { segments, spoken: `Starts in ${spoken}` };
}

/** 0..1 progress as a whole percent. */
export function percent(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

// ---------------------------------------------------------------------------
// Teach > Today
// ---------------------------------------------------------------------------
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "3 days" / "5 hours" / "12 minutes" since `value` (rounded down, at least 1). */
export function formatAge(value, now = new Date()) {
  const date = toDate(value);
  const current = toDate(now) || new Date();
  if (!date) return "";
  const minutes = Math.max(1, Math.floor((current.getTime() - date.getTime()) / 60_000));
  if (minutes >= 60 * 24) return plural(Math.floor(minutes / (60 * 24)), "day");
  if (minutes >= 60) return plural(Math.floor(minutes / 60), "hour");
  return plural(minutes, "minute");
}

/**
 * Rows for Teach > Today: one per job, each with a count, a sentence and
 * one action. `waiting` marks rows that need the teacher; the first waiting
 * row carries the screen's one champagne action.
 */
export function buildTeachRows(teach, now = new Date()) {
  if (!teach) return [];
  const rows = [];
  const grade = teach.to_grade || {};
  const gradeCount = Number(grade.count) || 0;
  rows.push({
    key: "to_grade",
    icon: "report",
    title: "To grade",
    count: gradeCount,
    text: gradeCount
      ? `${plural(gradeCount, "report")} waiting${grade.oldest_at ? `, oldest ${formatAge(grade.oldest_at, now)}` : ""}`
      : "No reports waiting",
    action: { label: "Open queue", href: grade.href || "/console/teach/grading" },
    waiting: gradeCount > 0,
  });

  const host = teach.host_next || {};
  const hosting = Boolean(host.session_id);
  const startsAt = toDate(host.starts_at);
  const isLive = hosting && startsAt && startsAt.getTime() <= (toDate(now) || new Date()).getTime();
  rows.push({
    key: "host_next",
    icon: "video",
    title: "You host next",
    count: null,
    text: hosting
      ? isLive
        ? `Live since ${formatWhen(host.starts_at, now).replace(/^Today /, "")}`
        : startsAt
          ? `${formatWhen(host.starts_at, now)}`
          : "A class is ready for you"
      : "No class scheduled",
    action: hosting ? { label: "Open studio", href: host.href } : { label: "Schedule a class", href: host.href || "/console/teach/classes" },
    waiting: Boolean(isLive),
    live: Boolean(isLive),
  });

  const recordings = teach.recordings || {};
  const processing = Number(recordings.processing) || 0;
  const toPublish = Number(recordings.to_publish) || 0;
  const recordingParts = [processing ? `${processing} processing` : "", toPublish ? `${toPublish} to publish` : ""].filter(Boolean);
  rows.push({
    key: "recordings",
    icon: "recording",
    title: "Recordings",
    count: processing + toPublish,
    text: recordingParts.length ? recordingParts.join(", ") : "Nothing processing",
    action: { label: toPublish ? "Review" : "Open recordings", href: recordings.href || "/console/teach/recordings" },
    waiting: toPublish > 0,
  });

  const exams = teach.exams_open || {};
  const examCount = Number(exams.count) || 0;
  rows.push({
    key: "exams_open",
    icon: "flag",
    title: "Exams open",
    count: examCount,
    text: examCount
      ? `${plural(examCount, "exam")} open${Number(exams.eligible) ? ` · ${Number(exams.submitted) || 0}/${Number(exams.eligible)} submitted` : ""}`
      : "No exam open",
    action: { label: examCount === 1 ? "Open exam" : "Open exams", href: exams.href || "/console/teach/exams" },
    waiting: false,
  });

  const firstWaiting = rows.find((row) => row.waiting);
  return rows.map((row) => ({ ...row, accent: row === firstWaiting }));
}

/** True when nothing in Teach > Today needs the teacher. */
export function isAllCaughtUp(rows) {
  return rows.every((row) => !row.waiting);
}
