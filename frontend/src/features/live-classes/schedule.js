// Weekly live-class schedule: short labels and an "Add to calendar" file.
// Pure functions (no React, no DOM) so they run in plain Node tests.
import { DEFAULT_LIVE_CLASS_SCHEDULE } from "../../utils/liveClassSchedule";

const DAY_CODES = {
  sunday: "SU",
  monday: "MO",
  tuesday: "TU",
  wednesday: "WE",
  thursday: "TH",
  friday: "FR",
  saturday: "SA",
};

function scheduleDays(schedule) {
  const days = Array.isArray(schedule?.days) && schedule.days.length ? schedule.days : DEFAULT_LIVE_CLASS_SCHEDULE.days;
  return days.map((day) => String(day || "").trim()).filter((day) => DAY_CODES[day.toLowerCase()]);
}

function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

function formatClock({ hours, minutes }, { withPeriod = true } = {}) {
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  const text = `${hour12}:${String(minutes).padStart(2, "0")}`;
  return withPeriod ? `${text} ${period}` : text;
}

/** "Fri, Sat & Sun". */
export function formatScheduleDays(schedule) {
  const short = scheduleDays(schedule).map((day) => day.slice(0, 3));
  if (short.length <= 1) return short.join("");
  return `${short.slice(0, -1).join(", ")} & ${short[short.length - 1]}`;
}

/** "7:00 – 8:00 PM IST" (falls back to the schedule label). */
export function formatScheduleTime(schedule) {
  const source = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
  const start = parseClock(source.start_time);
  const end = parseClock(source.end_time);
  const zone = source.timezone_label || "";
  if (!start || !end) return source.label || DEFAULT_LIVE_CLASS_SCHEDULE.label;
  const samePeriod = start.hours >= 12 === end.hours >= 12;
  const range = `${formatClock(start, { withPeriod: !samePeriod })} – ${formatClock(end)}`;
  return zone ? `${range} ${zone}` : range;
}

/** "Fri, Sat & Sun · 7:00 – 8:00 PM IST". */
export function formatScheduleSummary(schedule) {
  return `${formatScheduleDays(schedule)} · ${formatScheduleTime(schedule)}`;
}

// Offset (ms) of `timeZone` from UTC at `date`.
function timeZoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The UTC instant of a wall-clock time in `timeZone`.
function zonedTimeToDate({ year, month, day, hours, minutes }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hours, minutes);
  const first = guess - timeZoneOffset(new Date(guess), timeZone);
  return new Date(guess - timeZoneOffset(new Date(first), timeZone));
}

/**
 * Start of the next class window that has not finished yet: the server's
 * `next_start` when present, otherwise computed from the weekly days/times.
 */
export function getNextClassStart(schedule, now = new Date()) {
  const source = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
  const fromServer = source.next_start ? new Date(source.next_start) : null;
  if (fromServer && !Number.isNaN(fromServer.getTime())) return fromServer;

  const timeZone = source.timezone || DEFAULT_LIVE_CLASS_SCHEDULE.timezone;
  const start = parseClock(source.start_time) || parseClock(DEFAULT_LIVE_CLASS_SCHEDULE.start_time);
  const end = parseClock(source.end_time) || parseClock(DEFAULT_LIVE_CLASS_SCHEDULE.end_time);
  const dayNames = scheduleDays(source).map((day) => day.toLowerCase());
  try {
    for (let offset = 0; offset < 8; offset += 1) {
      const candidate = new Date(now.getTime() + offset * 86_400_000);
      const parts = zonedDateParts(candidate, timeZone);
      if (!dayNames.includes(parts.weekday)) continue;
      const date = { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
      const windowEnd = zonedTimeToDate({ ...date, ...end }, timeZone);
      if (windowEnd.getTime() <= now.getTime()) continue;
      return zonedTimeToDate({ ...date, ...start }, timeZone);
    }
  } catch {
    return null;
  }
  return null;
}

/** "Today · 7:00 PM IST", "Tomorrow · 7:00 PM IST" or "Fri, 13 Nov · 7:00 PM IST". */
export function formatNextClass(schedule, now = new Date()) {
  const source = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
  const start = getNextClassStart(source, now);
  if (!start) return formatScheduleSummary(source);
  const timeZone = source.timezone || DEFAULT_LIVE_CLASS_SCHEDULE.timezone;
  try {
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(start);
    const zone = source.timezone_label || "";
    const dayKey = (date) => {
      const parts = zonedDateParts(date, timeZone);
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    let day;
    if (dayKey(start) === dayKey(now)) day = "Today";
    else if (dayKey(start) === dayKey(new Date(now.getTime() + 86_400_000))) day = "Tomorrow";
    else {
      day = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" })
        .format(start)
        .replace(/^(\w+) /, "$1, ");
    }
    return `${day} · ${time}${zone ? ` ${zone}` : ""}`;
  } catch {
    return formatScheduleSummary(source);
  }
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || "";
  return { weekday: read("weekday").toLowerCase(), year: read("year"), month: read("month"), day: read("day") };
}

/** The first class date (YYYYMMDD in the schedule's time zone). */
function firstClassDate(schedule, now, timeZone, dayNames) {
  const nextStart = schedule?.next_start ? new Date(schedule.next_start) : null;
  if (nextStart && !Number.isNaN(nextStart.getTime())) {
    const parts = zonedDateParts(nextStart, timeZone);
    return `${parts.year}${parts.month}${parts.day}`;
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 86_400_000);
    const parts = zonedDateParts(candidate, timeZone);
    if (dayNames.includes(parts.weekday)) return `${parts.year}${parts.month}${parts.day}`;
  }
  return "";
}

function icsTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

const KOLKATA_TIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Kolkata",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0530",
  "TZOFFSETTO:+0530",
  "TZNAME:IST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/**
 * iCalendar text for the recurring weekly class window, or "" when the
 * schedule has no usable days/times. Works with Google, Apple and Outlook.
 */
export function buildLiveScheduleIcs(schedule, { now = new Date(), title = "Live class", url = "", brand = "Live classes" } = {}) {
  const source = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;
  const timeZone = source.timezone || DEFAULT_LIVE_CLASS_SCHEDULE.timezone;
  const start = parseClock(source.start_time);
  const end = parseClock(source.end_time);
  const days = scheduleDays(source);
  if (!start || !end || days.length === 0) return "";
  if (end.hours * 60 + end.minutes <= start.hours * 60 + start.minutes) return "";

  let date = "";
  try {
    date = firstClassDate(source, now, timeZone, days.map((day) => day.toLowerCase()));
  } catch {
    return "";
  }
  if (!date) return "";

  const clock = ({ hours, minutes }) => `${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}00`;
  const byDay = days.map((day) => DAY_CODES[day.toLowerCase()]).join(",");
  const description = url ? `Join your live class: ${url}` : "Join your live class from the Live classes page.";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${escapeIcsText(brand)}//Live classes//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...(timeZone === "Asia/Kolkata" ? KOLKATA_TIMEZONE : []),
    "BEGIN:VEVENT",
    `UID:live-classes-${date}-${clock(start)}@${escapeIcsText(brand).replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "live"}`,
    `DTSTAMP:${icsTimestamp(now)}`,
    `DTSTART;TZID=${timeZone}:${date}T${clock(start)}`,
    `DTEND;TZID=${timeZone}:${date}T${clock(end)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byDay}`,
    `SUMMARY:${escapeIcsText(title)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    ...(url ? [`URL:${url}`] : []),
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${escapeIcsText(title)} starts in 15 minutes`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}
