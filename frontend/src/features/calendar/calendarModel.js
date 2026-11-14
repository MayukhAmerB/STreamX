// Pure calendar helpers (no React, no DOM). OWNER: WS-ATTENDANCE (calendar).
// Dates are "YYYY-MM-DD" day keys in India time (Asia/Kolkata, no DST); all
// arithmetic runs on UTC midnights so the viewer's own time zone never shifts a day.

export const IST = "Asia/Kolkata";
export const VIEWS = Object.freeze(["month", "week", "agenda"]);
export const WEEKDAYS = Object.freeze([
  { value: 0, short: "Mon", label: "Monday" },
  { value: 1, short: "Tue", label: "Tuesday" },
  { value: 2, short: "Wed", label: "Wednesday" },
  { value: 3, short: "Thu", label: "Thursday" },
  { value: 4, short: "Fri", label: "Friday" },
  { value: 5, short: "Sat", label: "Saturday" },
  { value: 6, short: "Sun", label: "Sunday" },
]);

/** Event status vocabulary (icon + label + luminance, never hue). */
export const EVENT_STATUS = Object.freeze({
  upcoming: { label: "Upcoming", icon: "clock", tone: "mid" },
  live: { label: "Live now", icon: "live", tone: "accent" },
  ended: { label: "Ended", icon: "check", tone: "dim" },
  cancelled: { label: "Cancelled", icon: "close", tone: "dim" },
});

export function eventStatus(status) {
  return EVENT_STATUS[status] || EVENT_STATUS.upcoming;
}

/** Phones (≤ 640 px, e.g. 390) open on the agenda; wider screens on the month. */
export function defaultView(width) {
  return Number(width) > 0 && Number(width) <= 640 ? "agenda" : "month";
}

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: IST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The India-time day key of an instant ("2026-11-21"). */
export function dayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return partsFormatter.format(date);
}

export function todayKey(now = new Date()) {
  return dayKey(now);
}

function toUtc(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function fromUtc(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(key, days) {
  const date = toUtc(key);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return fromUtc(date);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(key) {
  return (toUtc(key).getUTCDay() + 6) % 7;
}

export function startOfWeek(key) {
  return addDays(key, -weekdayOf(key));
}

export function startOfMonth(key) {
  return `${String(key).slice(0, 7)}-01`;
}

export function addMonths(key, months) {
  const date = toUtc(startOfMonth(key));
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  return fromUtc(date);
}

/** Weeks (Monday first) covering the month of `key`: [[{ key, inMonth, isToday }, ×7], …]. */
export function monthGrid(key, today = todayKey()) {
  const first = startOfMonth(key);
  const month = first.slice(0, 7);
  let cursor = startOfWeek(first);
  const weeks = [];
  do {
    const week = [];
    for (let index = 0; index < 7; index += 1) {
      week.push({ key: cursor, inMonth: cursor.slice(0, 7) === month, isToday: cursor === today });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  } while (cursor.slice(0, 7) === month);
  return weeks;
}

export function weekKeys(key) {
  const start = startOfWeek(key);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

/** The `{ from, to }` (day keys, `to` exclusive) to fetch for a view. */
export function rangeForView(view, anchor) {
  if (view === "week") {
    const start = startOfWeek(anchor);
    return { from: start, to: addDays(start, 7) };
  }
  if (view === "agenda") {
    return { from: addDays(anchor, -7), to: addDays(anchor, 35) };
  }
  const grid = monthGrid(anchor);
  return { from: grid[0][0].key, to: addDays(grid[grid.length - 1][6].key, 1) };
}

export function shiftAnchor(view, anchor, delta) {
  if (view === "month") return addMonths(anchor, delta);
  if (view === "week") return addDays(anchor, 7 * delta);
  return addDays(anchor, 28 * delta);
}

/** `{ dayKey: [events sorted by start] }` */
export function groupByDay(events = []) {
  const groups = {};
  for (const event of events || []) {
    const key = event?.date || dayKey(event?.starts_at);
    if (!key) continue;
    (groups[key] ||= []).push(event);
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  }
  return groups;
}

const timeFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true });
const longDay = new Intl.DateTimeFormat("en-IN", { timeZone: IST, weekday: "long", day: "numeric", month: "long" });
const monthTitle = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

export function formatClock(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : timeFormatter.format(date).toUpperCase();
}

/** "7:00 PM – 8:00 PM IST" */
export function formatTimeRange(event) {
  const start = formatClock(event?.starts_at);
  const end = formatClock(event?.ends_at);
  if (!start) return "";
  return `${start}${end ? ` – ${end}` : ""} IST`;
}

export function formatDayHeading(key) {
  return longDay.format(new Date(`${key}T12:00:00+05:30`));
}

export function formatMonthTitle(key) {
  return monthTitle.format(toUtc(startOfMonth(key)));
}

// --- add to calendar ---------------------------------------------------------------------
function icsStamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** A one-event .ics file for "Add to calendar". */
export function eventIcs(event, { origin = "" } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Al Syed Initiative//Class calendar//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(event.id)}@alsyedinitiative.com`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(event.starts_at)}`,
    `DTEND:${icsStamp(event.ends_at)}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText([event.course?.title, event.host?.name ? `Host: ${event.host.name}` : ""].filter(Boolean).join("\n"))}`,
    origin && event.join_path ? `URL:${origin}${event.join_path}` : "",
    `STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return `${lines.join("\r\n")}\r\n`;
}

/** Google Calendar "add event" link. */
export function googleCalendarUrl(event, { origin = "" } = {}) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title || "Live class",
    dates: `${icsStamp(event.starts_at)}/${icsStamp(event.ends_at)}`,
    details: [event.course?.title, origin && event.join_path ? `${origin}${event.join_path}` : ""].filter(Boolean).join("\n"),
    ctz: IST,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// --- schedule form -------------------------------------------------------------------------
export function emptyScheduleForm(today = todayKey()) {
  return {
    course: "",
    live_class: "",
    name: "",
    title_pattern: "{course} · Class {n}",
    start_date: today,
    end_date: addDays(today, 90),
    weekdays: [4, 5, 6],
    start_time: "19:00",
    duration_minutes: 60,
    host: "",
    session_type: "meeting",
    description: "",
    exceptions: [],
  };
}

export function scheduleToForm(schedule) {
  return {
    course: String(schedule.course?.id ?? ""),
    live_class: String(schedule.live_class?.id ?? ""),
    name: schedule.name || "",
    title_pattern: schedule.title_pattern || "",
    start_date: schedule.start_date,
    end_date: schedule.end_date,
    weekdays: [...(schedule.weekdays || [])],
    start_time: schedule.start_time,
    duration_minutes: schedule.duration_minutes,
    host: String(schedule.host?.id ?? ""),
    session_type: schedule.session_type || "meeting",
    description: schedule.description || "",
    exceptions: [],
  };
}

export function toggleWeekday(weekdays = [], day) {
  const set = new Set(weekdays);
  if (set.has(day)) set.delete(day);
  else set.add(day);
  return [...set].sort((a, b) => a - b);
}

/** `{ errors }` when the form is incomplete, else `{ body }` for the API. */
export function buildSchedulePayload(form) {
  const errors = {};
  if (!form.course) errors.course = "Pick a batch.";
  if (!form.live_class) errors.live_class = "Pick the live class students join.";
  if (!form.start_date) errors.start_date = "Pick a start date.";
  if (!form.end_date) errors.end_date = "Pick an end date.";
  if (form.start_date && form.end_date && form.end_date < form.start_date) errors.end_date = "The end date is before the start.";
  if (!form.weekdays?.length) errors.weekdays = "Pick at least one weekday.";
  if (!/^\d{2}:\d{2}$/.test(String(form.start_time || ""))) errors.start_time = "Pick a start time.";
  const duration = Number(form.duration_minutes);
  if (!Number.isFinite(duration) || duration < 15 || duration > 600) errors.duration_minutes = "Use 15 to 600 minutes.";
  if (Object.keys(errors).length) return { errors };
  const body = {
    course: Number(form.course),
    live_class: Number(form.live_class),
    name: String(form.name || "").trim(),
    title_pattern: String(form.title_pattern || "").trim() || "{course} · Class {n}",
    start_date: form.start_date,
    end_date: form.end_date,
    weekdays: [...form.weekdays].sort((a, b) => a - b),
    start_time: form.start_time,
    duration_minutes: duration,
    session_type: form.session_type || "meeting",
    description: String(form.description || "").trim(),
    timezone: IST,
    exceptions: form.exceptions || [],
  };
  if (form.host) body.host = Number(form.host);
  return { body };
}

/** An exception body from the small "change one date" form, or `{ error }`. */
export function buildExceptionPayload({ kind, date, newDate, newTime, note, title, duration }) {
  if (!["cancelled", "rescheduled", "extra"].includes(kind)) return { error: "Pick what changes." };
  if (kind !== "extra" && !date) return { error: "Pick the class date." };
  const body = { kind, note: String(note || "").trim(), title: String(title || "").trim() };
  if (date) body.date = date;
  if (kind !== "cancelled") {
    if (!newDate || !/^\d{2}:\d{2}$/.test(String(newTime || ""))) return { error: "Pick the new date and time." };
    body.new_start = `${newDate}T${newTime}:00+05:30`;
    if (kind === "extra" && !body.date) body.date = newDate;
    if (duration) body.duration_minutes = Number(duration);
  }
  return { body };
}
