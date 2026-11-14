// Small formatting helpers for the Admin workspace. OWNER: WS-G. Pure.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "just now", "12 min", "5 h", "2 d", "3 w" (how long something waited). */
export function shortAge(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return "";
  const elapsed = Math.max(0, toDate(now).getTime() - date.getTime());
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  if (elapsed < 14 * DAY) return `${Math.floor(elapsed / DAY)} d`;
  return `${Math.floor(elapsed / (7 * DAY))} w`;
}

/** "5 h ago" / "just now". */
export function ago(value, now = new Date()) {
  const age = shortAge(value, now);
  if (!age) return "";
  return age === "just now" ? age : `${age} ago`;
}

export function timeOfDay(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function greetingFor(date = new Date()) {
  const hour = toDate(date).getHours();
  if (hour < 5) return "Good evening";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function firstName(user) {
  const name = String(user?.full_name || user?.name || "").trim();
  return name ? name.split(/\s+/)[0] : "";
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Joins words as "a, b and c". */
export function listWords(words = []) {
  const items = words.filter(Boolean);
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
