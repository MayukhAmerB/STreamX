// Display formatting for the course player. Pure functions (no React), so
// they are unit tested in plain Node.

/** 75 -> "1:15", 3725 -> "1:02:05". */
export function formatDuration(totalSeconds) {
  const normalized = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Total running time for a module header: "45 min", "1 hr 20 min". */
export function formatRunningTime(totalSeconds) {
  const minutes = Math.round(Math.max(0, Number(totalSeconds) || 0) / 60);
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function formatFileSize(totalBytes) {
  const normalized = Math.max(0, Number(totalBytes) || 0);
  if (normalized < 1024) return `${normalized} B`;
  if (normalized < 1024 * 1024) return `${(normalized / 1024).toFixed(1)} KB`;
  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeDisplayText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

/** "10 Nov, 14:20" style timestamp (used for "Saved ..." notes). */
export function formatDateTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Short relative time, the way YouTube/Slack show comment ages:
 * "Just now", "5m ago", "2h ago", "3d ago", "2w ago", then "12 Mar" or
 * "12 Mar 2024" for older dates.
 */
export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.floor((Number(now) - time) / 1000));
  if (seconds < 45) return "Just now";
  if (seconds < HOUR) return `${Math.max(1, Math.round(seconds / MINUTE))}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  if (seconds < WEEK) return `${Math.floor(seconds / DAY)}d ago`;
  if (seconds < 5 * WEEK) return `${Math.floor(seconds / WEEK)}w ago`;
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(Number(now)).getFullYear();
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full date for tooltips / <time title>. */
export function formatFullDate(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** 950 -> "950", 1250 -> "1.2K", 2300000 -> "2.3M". */
export function formatCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const thousands = count / 1000;
    return `${thousands >= 10 ? Math.floor(thousands) : Math.floor(thousands * 10) / 10}K`;
  }
  const millions = count / 1_000_000;
  return `${millions >= 10 ? Math.floor(millions) : Math.floor(millions * 10) / 10}M`;
}

/** "Asha Rao" -> "AR", "imran" -> "I", "" -> "?". */
export function getInitials(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1 ? [words[0][0]] : [words[0][0], words[words.length - 1][0]];
  return letters.join("").toUpperCase();
}

/** Stable 0..(buckets-1) index for an avatar colour, from a user id or name. */
export function avatarTone(seed, buckets = 6) {
  const text = String(seed ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash % buckets;
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
