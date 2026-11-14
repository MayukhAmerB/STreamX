// Pure helpers for the engagement UI (no React, no DOM). OWNER: WS-LEARN.

/**
 * The rank ladder (mirrors backend apps/engagement/rules.py LEVELS, re-balanced
 * for the XP economy v2; GET /engagement/levels/ is the source of truth).
 */
export const LEVELS = Object.freeze([
  { number: 1, key: "recruit", title: "Recruit", min_xp: 0 },
  { number: 2, key: "operative", title: "Operative", min_xp: 1500 },
  { number: 3, key: "operator", title: "Operator", min_xp: 3500 },
  { number: 4, key: "analyst", title: "Analyst", min_xp: 6000 },
  { number: 5, key: "specialist", title: "Specialist", min_xp: 9000 },
  { number: 6, key: "senior_analyst", title: "Senior Analyst", min_xp: 12000 },
  { number: 7, key: "lead_investigator", title: "Lead Investigator", min_xp: 15500 },
  { number: 8, key: "elite_operator", title: "Elite Operator", min_xp: 19000 },
]);

/** True while the /me payload says a new rank has not been celebrated yet. */
export function levelUpPending(me) {
  return Boolean(me?.level_up?.pending && me?.level?.key);
}

/**
 * Badge tiers carry no hue (palette law): the tier is a word plus a number of
 * pips (1-4) and a ring weight on the medal.
 */
export const BADGE_TIERS = Object.freeze({
  bronze: { label: "Bronze", pips: 1 },
  silver: { label: "Silver", pips: 2 },
  gold: { label: "Gold", pips: 3 },
  platinum: { label: "Platinum", pips: 4 },
});

export function tierInfo(tier) {
  return BADGE_TIERS[String(tier || "").toLowerCase()] || { label: "", pips: 0 };
}

/** Which line-art glyph a badge uses, from its key. */
export function badgeGlyph(key) {
  const value = String(key || "");
  // Release-day legacy badges and the weekly podium (granted by jobs).
  if (/^batch_pioneer_\d+$/.test(value)) return "pioneer";
  if (/^founding_/.test(value)) return "founding";
  if (/podium/.test(value)) return "podium";
  if (/streak|comeback|weekend/.test(value)) return "streak";
  if (/report|punctual|analyst/.test(value)) return "report";
  if (/exam|ace|perfect|top_3/.test(value)) return "exam";
  if (/live/.test(value)) return "live";
  if (/xp_/.test(value)) return "xp";
  if (/night|early/.test(value)) return "clock";
  if (/finisher|course/.test(value)) return "course";
  if (/focus/.test(value)) return "focus";
  return "lecture";
}

const numberFormat = new Intl.NumberFormat("en-IN");

/** 12345 → "12,345" (Indian grouping for large numbers, as elsewhere on the site). */
export function formatXp(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  return numberFormat.format(number);
}

/** 2700 → "45 min", 7500 → "2 h 05 min", 0 → "0 min". */
export function formatStudyTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (!hours) return `${minutes} min`;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

/** 0..1 → whole percent (clamped). Accepts 0..100 when `scale` is 100. */
export function toPercent(value, scale = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(Math.max(0, Math.min(1, number / scale)) * 100);
}

/** Progress inside the current level: `{ percent, into, span, remaining }`. */
export function levelProgress(xp, level, nextLevel) {
  const current = Math.max(0, Number(xp) || 0);
  const floor = Number(level?.min_xp) || 0;
  if (!nextLevel) return { percent: 100, into: current - floor, span: 0, remaining: 0 };
  const ceiling = Number(nextLevel.min_xp) || floor;
  const span = Math.max(1, ceiling - floor);
  const into = Math.max(0, Math.min(span, current - floor));
  return { percent: Math.round((into / span) * 100), into, span, remaining: Math.max(0, ceiling - current) };
}

/** The next level for an XP total (null at the top). */
export function nextLevelFor(xp) {
  const current = Math.max(0, Number(xp) || 0);
  return LEVELS.find((level) => current < level.min_xp) || null;
}

/** Streak line: "3-day streak", "Studied today", "Freeze used on Tue". */
export function describeStreak(streak) {
  if (!streak) return { count: 0, label: "No streak yet", detail: "Study today to start one." };
  const count = Math.max(0, Number(streak.current) || 0);
  const label = count === 1 ? "1-day streak" : `${count}-day streak`;
  let detail = "";
  if (!streak.alive || count === 0) detail = "Study today to start a new streak.";
  else if (streak.studied_today) detail = "You studied today.";
  else detail = "Study today to keep it going.";
  if (streak.freeze_covering) detail = `${detail} A freeze covered a missed day.`;
  return { count, label, detail, best: Math.max(0, Number(streak.best) || 0), freeze: Boolean(streak.freeze_available) };
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** ISO → "14 Nov 2026" (IST), "" when invalid. */
export function formatEarnedDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormat.format(date);
}

/** Leaderboard batch label: "OSINT Foundations · Batch 7". */
export function batchLabel(batch) {
  if (!batch) return "";
  return [batch.title, batch.batch].filter(Boolean).join(" · ");
}

/** Week of "9 Nov" from the API's `week_start` (YYYY-MM-DD). */
export function formatWeekStart(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(date);
}

/** Splits a catalogue into earned (newest first) and locked (catalogue order). */
export function splitBadges(badges = []) {
  const list = Array.isArray(badges) ? badges.filter((badge) => badge && typeof badge === "object" && badge.key) : [];
  const earned = list
    .filter((badge) => badge.earned)
    .sort((a, b) => String(b.earned_at || "").localeCompare(String(a.earned_at || "")));
  const locked = list.filter((badge) => !badge.earned);
  return { earned, locked, total: list.length };
}

/**
 * Labels for the viewer's leaderboard display setting. Owner privacy rule:
 * students appear by their profile handle only (never a real name), or not at
 * all. Retired server values ("initials", "name") read as "handle".
 */
export const DISPLAY_CHOICES = Object.freeze({
  handle: { label: "Handle", hint: "Others see your profile handle, for example @quiet_cipher." },
  hidden: { label: "Hidden", hint: "You are left off the board; you still see your own rank." },
});

/** Server value -> "handle" | "hidden". */
export function normalizeDisplay(value) {
  return value === "hidden" ? "hidden" : "handle";
}

/** Absolute URL for a share link (verify_url from the API, else this origin). */
export function verifyHref(achievement, origin = typeof window !== "undefined" ? window.location.origin : "") {
  if (achievement?.verify_url) return achievement.verify_url;
  return achievement?.slug ? `${origin}/achievements/${achievement.slug}` : "";
}

/* ---------------------------------------------------------------- journey */

// Legacy badges lead the "Your journey so far" screen, highest first.
const LEGACY_ORDER = ["founding_operative", "founding_graduate", "founding_member"];

function legacyRank(key) {
  const value = String(key || "");
  const index = LEGACY_ORDER.indexOf(value);
  if (index >= 0) return index;
  const pioneer = /^batch_pioneer_(\d+)$/.exec(value);
  if (pioneer) return LEGACY_ORDER.length + Number(pioneer[1]) / 10000;
  return Number.POSITIVE_INFINITY;
}

export function isLegacyBadge(badge) {
  return Boolean(badge?.legacy) || Number.isFinite(legacyRank(badge?.key));
}

/** Legacy badges first (Founding Operative, Graduate, Member, then Batch Pioneer by batch), then the rest in server order. */
export function orderJourneyBadges(badges = []) {
  const list = (Array.isArray(badges) ? badges : []).filter((badge) => badge && badge.key && badge.title);
  return list
    .map((badge, index) => ({ badge, index, rank: legacyRank(badge.key) }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map((entry) => entry.badge);
}

/** `GET /engagement/journey/` data → `null` (nothing to show) or a safe view model. */
export function normalizeJourney(data) {
  if (!data || data.show !== true || !data.journey || typeof data.journey !== "object") return null;
  const journey = data.journey;
  const list = (value) => (Array.isArray(value) ? value : []);
  return {
    active: Boolean(journey.active),
    graduate: Boolean(journey.graduate),
    batches: list(journey.batches).filter((value) => Number.isFinite(Number(value))).map(Number),
    xp: Math.max(0, Number(journey.xp) || 0),
    level: journey.level && typeof journey.level === "object" ? journey.level : null,
    nextLevel: journey.next_level && typeof journey.next_level === "object" ? journey.next_level : null,
    bestStreak: Math.max(0, Number(journey.best_streak) || 0),
    rank: Number(journey.position?.all_time_rank) > 0 ? Number(journey.position.all_time_rank) : null,
    badges: orderJourneyBadges(journey.badges),
    certificates: list(journey.certificates).filter((item) => item && item.reference && /^https?:\/\//.test(String(item.url || ""))),
    glow: journey.founding_glow?.active ? { endsAt: journey.founding_glow.ends_at || null } : null,
    share: {
      handle: String(journey.share?.handle || ""),
      profilePath: journey.share?.profile_path ? String(journey.share.profile_path) : "",
      certificateUrl: journey.share?.certificate_url ? String(journey.share.certificate_url) : "",
    },
  };
}

/** What "Share" sends: the public profile (when published) or else the first certificate. */
export function journeyShareUrl(journey, origin = typeof window !== "undefined" ? window.location.origin : "") {
  if (!journey) return "";
  if (journey.share.profilePath && journey.share.profilePath.startsWith("/")) return `${origin}${journey.share.profilePath}`;
  return journey.share.certificateUrl || "";
}
