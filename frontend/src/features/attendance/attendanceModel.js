// Pure attendance helpers (no React, no DOM). OWNER: WS-ATTENDANCE.
// Palette law: status is shown by icon + label + luminance, never by hue.

export const IST = "Asia/Kolkata";

/** Status vocabulary. `tone`: strong (white) > mid (white/70) > dim (white/45). */
export const STATUS_META = Object.freeze({
  present: { label: "Attended", icon: "check", tone: "strong", description: "40+ minutes in the live class" },
  partial: { label: "Partial", icon: "half", tone: "mid", description: "Joined, but under the attendance bar" },
  absent: { label: "Absent", icon: "circle", tone: "dim", description: "Did not join the live class" },
  excused: { label: "Excused", icon: "info", tone: "mid", description: "Excused by your instructor" },
  not_joined: { label: "Not joined", icon: "dashed", tone: "dim", description: "Has not joined yet" },
});

export const STATUS_FILTERS = Object.freeze([
  { value: "", label: "All classes" },
  { value: "present", label: "Attended" },
  { value: "partial", label: "Partial" },
  { value: "absent", label: "Absent" },
  { value: "excused", label: "Excused" },
]);

export const OVERRIDE_OPTIONS = Object.freeze([
  { value: "excused", label: "Excused" },
  { value: "present", label: "Present" },
  { value: "partial", label: "Partial" },
  { value: "absent", label: "Absent" },
  { value: "auto", label: "Automatic (remove correction)" },
]);

export function statusMeta(status) {
  return STATUS_META[status] || { label: status ? String(status) : "Unknown", icon: "circle", tone: "dim", description: "" };
}

/** Single-character matrix cell (with the label for screen readers). */
export function matrixSymbol(status) {
  switch (status) {
    case "present":
      return "●";
    case "partial":
      return "◐";
    case "absent":
      return "○";
    case "excused":
      return "E";
    default:
      return "·";
  }
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0%";
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

/** 0 → "0 min", 65 → "1 h 05 min". */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${hours} h ${String(rest).padStart(2, "0")} min`;
}

/** "Attended 7 of 9 classes" (excused classes are left out of the total). */
export function summaryLine(summary) {
  const attended = Number(summary?.attended || 0);
  const total = Number(summary?.total || 0);
  if (!total) return "No finished classes yet";
  return `Attended ${attended} of ${total} ${total === 1 ? "class" : "classes"}`;
}

export function streakLabel(streak) {
  const current = Number(streak?.current || 0);
  if (!current) return "No current streak";
  return `${current} ${current === 1 ? "class" : "classes"} in a row`;
}

/** The rule in words, from the server's `rule` payload. */
export function ruleLabel(rule) {
  return rule?.label || `Attended = ${rule?.present_min_minutes || 40}+ minutes live`;
}

const dateFormatters = new Map();
function formatter(options) {
  const key = JSON.stringify(options);
  if (!dateFormatters.has(key)) dateFormatters.set(key, new Intl.DateTimeFormat("en-IN", { timeZone: IST, ...options }));
  return dateFormatters.get(key);
}

/** "Fri, 21 Nov 2026" in India time; "" for an empty value. */
export function formatDate(value, { withYear = true } = {}) {
  if (!value) return "";
  const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00+05:30`) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatter({ weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(date);
}

/** "7:05 PM" in India time. */
export function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatter({ hour: "numeric", minute: "2-digit", hour12: true }).format(date).toUpperCase();
}

/** Percent bar width, clamped 0..100. */
export function barWidth(percent) {
  const number = Number(percent);
  if (!Number.isFinite(number)) return "0%";
  return `${Math.max(0, Math.min(100, number))}%`;
}

/** Validated body for POST …/override/ or an `{ error }`. */
export function buildOverride({ userId, status, reason }) {
  const text = String(reason || "").trim();
  if (!userId) return { error: "Pick a student." };
  if (!OVERRIDE_OPTIONS.some((option) => option.value === status)) return { error: "Pick a status." };
  if (text.length < 3) return { error: "Give a short reason (3+ characters)." };
  if (text.length > 300) return { error: "Keep the reason under 300 characters." };
  return { body: { user_id: Number(userId), status, reason: text } };
}

/** Roster counts for a quick strip: { present, partial, absent, excused, not_joined, online }. */
export function rosterCounts(rows = []) {
  const counts = { present: 0, partial: 0, absent: 0, excused: 0, not_joined: 0, online: 0 };
  for (const row of rows || []) {
    if (counts[row?.status] !== undefined) counts[row.status] += 1;
    if (row?.online) counts.online += 1;
  }
  return counts;
}

/** Case-insensitive search over a roster's names and emails. */
export function filterRoster(rows = [], query = "") {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return rows || [];
  return (rows || []).filter(
    (row) => String(row?.user?.name || "").toLowerCase().includes(needle) || String(row?.user?.email || "").toLowerCase().includes(needle)
  );
}
