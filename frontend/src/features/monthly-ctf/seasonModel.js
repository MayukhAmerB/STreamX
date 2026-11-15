// Pure helpers for the Monthly OSINT CTF UI (formatting, phases, tiers).
// OWNER: WS-MONTHLY-CTF. No React, so they are unit tested in plain Node.

export const PLAY_PATH = "/monthly-ctf/play";
export const PUBLIC_PATH = "/monthly-ctf";
export const HALL_OF_FAME_PATH = "/monthly-ctf/hall-of-fame";
// Finalist certificates live in the certificate system: /certificates/<slug> opens the
// canonical reference number (the old /monthly-ctf/certificates/<slug> only redirects there).
export const certificatePath = (slug) => `/certificates/${encodeURIComponent(slug)}`;

export const EMPTY_COSMETICS = Object.freeze({ aura: false, frame: false, frame_tier: "", title: "", until: null });

/** Status words: always an icon + a word, never a colour alone (palette law). */
export const PHASES = Object.freeze({
  open: { label: "Open", icon: "live" },
  upcoming: { label: "Opens soon", icon: "clock" },
  closed: { label: "Closed · results pending", icon: "half" },
  results: { label: "Results final", icon: "check" },
  none: { label: "Next case soon", icon: "clock" },
  off: { label: "Opens soon", icon: "clock" },
});

export const TIER_LABELS = Object.freeze({ gold: "Gold", silver: "Silver", bronze: "Bronze" });
export const TIER_BY_RANK = Object.freeze({ 1: "gold", 2: "silver", 3: "bronze" });

export const DIFFICULTY_LABELS = Object.freeze({ easy: "Easy", medium: "Medium", hard: "Hard" });

export function phaseLabel(phase) {
  return (PHASES[phase] || PHASES.none).label;
}

/** 0 -> "0s", 75 -> "1m 15s", 3725 -> "1h 2m", 2 days -> "2d 3h". */
export function formatDuration(totalSeconds) {
  const value = Number(totalSeconds);
  if (!Number.isFinite(value) || value < 0) return "—";
  const seconds = Math.floor(value);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

/** Long form for screen readers: "1 hour 2 minutes". */
export function spokenDuration(totalSeconds) {
  const value = Number(totalSeconds);
  if (!Number.isFinite(value) || value < 0) return "unknown time";
  const seconds = Math.floor(value);
  const parts = [
    [Math.floor(seconds / 86400), "day"],
    [Math.floor((seconds % 86400) / 3600), "hour"],
    [Math.floor((seconds % 3600) / 60), "minute"],
  ].filter(([amount]) => amount > 0);
  if (!parts.length) return `${seconds % 60} second${seconds % 60 === 1 ? "" : "s"}`;
  return parts
    .slice(0, 2)
    .map(([amount, unit]) => `${amount} ${unit}${amount === 1 ? "" : "s"}`)
    .join(" ");
}

const IST = "Asia/Kolkata";

/** "30 Nov, 23:59 IST" */
export function formatIst(value, { withTime = true } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options = withTime
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: IST }
    : { day: "numeric", month: "short", year: "numeric", timeZone: IST };
  const text = new Intl.DateTimeFormat("en-GB", options).format(date);
  return withTime ? `${text.replace(/,?\s(\d{2}:\d{2})$/, ", $1")} IST` : text;
}

/** Seconds left until `target` from `now` (never negative). */
export function secondsUntil(target, now = Date.now()) {
  const end = new Date(target).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - now) / 1000));
}

/** The countdown the hero shows: closing time while open, opening time while upcoming. */
export function countdownFor(season, now = Date.now()) {
  if (!season) return null;
  if (season.phase === "open") return { label: "Closes in", seconds: secondsUntil(season.closes_at, now) };
  if (season.phase === "upcoming") return { label: "Opens in", seconds: secondsUntil(season.opens_at, now) };
  return null;
}

/** "1st", "2nd", "3rd", "11th", "22nd" */
export function ordinal(rank) {
  const value = Number(rank);
  if (!Number.isFinite(value) || value <= 0) return "";
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${{ 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th"}`;
}

/** Splits a brief into paragraphs on blank lines (the admin writes plain text). */
export function briefParagraphs(text) {
  return String(text || "")
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Two letters for an avatar from a public handle ("QuietFalcon42" -> "QF"). */
export function handleInitials(name) {
  const text = String(name || "").trim();
  if (!text) return "?";
  const capitals = text.replace(/[^A-Z]/g, "");
  if (capitals.length >= 2) return capitals.slice(0, 2);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

/** Normalises a cosmetics object from the API (missing keys -> empty). */
export function normaliseCosmetics(value) {
  if (!value || typeof value !== "object") return EMPTY_COSMETICS;
  return {
    aura: Boolean(value.aura),
    frame: Boolean(value.frame),
    frame_tier: TIER_LABELS[value.frame_tier] ? value.frame_tier : "",
    title: String(value.title || ""),
    until: value.until || null,
  };
}

export function hasCosmetics(value) {
  const cosmetics = normaliseCosmetics(value);
  return cosmetics.aura || cosmetics.frame || Boolean(cosmetics.title);
}

/** Where the "Play" call to action goes for this viewer. */
export function playTarget(signedIn) {
  return signedIn ? PLAY_PATH : `/login?next=${encodeURIComponent(PLAY_PATH)}`;
}

/** Feature switch state from the capabilities payload: true / false / null (unknown). */
export function monthlyCtfEnabled(caps) {
  const flag = caps?.features?.monthly_ctf;
  if (!flag || typeof flag !== "object") return null;
  return Boolean(flag.enabled);
}
