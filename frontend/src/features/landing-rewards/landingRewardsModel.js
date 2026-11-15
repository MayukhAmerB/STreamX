// Pure view model for the signed-in "Your progress" showcase on the Friday
// landing (no React, no DOM). Inputs are the existing engagement payloads:
//   me      GET /engagement/me/              (xp, weekly_xp, level, badges, level_up)
//   board   GET /engagement/leaderboard/?period=week  (me.rank, me.handle, participants)
//   history GET /engagement/me/history/       (certificates; summary fallback)
//   profile GET /profiles/me/                 (handle fallback only)
// Owner privacy rule: the student is shown by HANDLE only. Real-name fields
// (`full_name`, `first_name`, `email`) are never read here.
import { LEVELS, formatXp, levelProgress, tierInfo } from "../engagement-ui/engagementModel";

export const METER_SEGMENTS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_DAYS = 14;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** 1 → "I" … 8 → "VIII". */
export function romanRank(number) {
  return ROMAN[Math.max(1, Math.min(ROMAN.length, Number(number) || 1)) - 1];
}

/**
 * The rank number (1-8) of a level payload: its `number`, else its `key` or
 * `title` matched against the ladder (older payloads), else 1.
 */
export function rankNumber(level) {
  if (typeof level === "number" || typeof level === "string") {
    const direct = Number(level);
    if (direct >= 1 && direct <= LEVELS.length) return Math.floor(direct);
  }
  const number = Number(level?.number);
  if (number >= 1 && number <= LEVELS.length) return Math.floor(number);
  const text = String((typeof level === "string" ? level : level?.key || level?.title) || "").trim().toLowerCase();
  const match = LEVELS.find((item) => item.key === text || item.title.toLowerCase() === text || item.key === text.replace(/\s+/g, "_"));
  return match ? match.number : 1;
}

/** The ladder entry for a level payload / number (falls back to the local ladder). */
export function rankFor(level) {
  const number = Number(level?.number) || 0;
  const local = LEVELS.find((item) => item.number === number) || LEVELS.find((item) => item.key === level?.key);
  if (!local) return LEVELS[0];
  return { ...local, ...(level && typeof level === "object" ? level : {}) };
}

/** "@quiet_cipher" from a handle string ("" when there is none). */
export function formatHandle(value) {
  const text = String(value || "").trim().replace(/^@+/, "");
  return text ? `@${text}` : "";
}

/**
 * Meter segments: `{ filled, fractions }` where `fractions[i]` is 0..1 (the
 * segment the student is inside is partly lit).
 */
export function meterSegments(percent, segments = METER_SEGMENTS) {
  const lit = (Math.max(0, Math.min(100, Number(percent) || 0)) / 100) * segments;
  const fractions = Array.from({ length: segments }, (_, index) => Math.max(0, Math.min(1, lit - index)));
  return { filled: Math.floor(lit), fractions: fractions.map((value) => Math.round(value * 100) / 100) };
}

const timeOf = (value) => {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
};

/** The newest badge or valid certificate: `{ kind, title, tier?, at }` or null. */
export function latestAchievement(badges = [], certificates = []) {
  const events = [
    ...badges.filter((badge) => badge?.title).map((badge) => ({ kind: "badge", title: badge.title, tier: badge.tier, at: timeOf(badge.earned_at) })),
    ...certificates
      .filter((item) => item?.valid !== false && (item?.title || item?.type_label))
      .map((item) => ({ kind: "certificate", title: item.title || item.type_label, at: timeOf(item.issued_at || item.issued_on) })),
  ];
  if (!events.length) return null;
  return events.sort((a, b) => b.at - a.at)[0];
}

/**
 * The congratulatory line, from the most meaningful recent thing:
 * a promotion not yet celebrated, then a fresh badge or certificate (14 days),
 * then a podium week, then this week's XP, then the last achievement, then
 * the road to the next rank.
 */
export function cheerLine(view, now = Date.now()) {
  const latest = view.latest;
  const fresh = latest && latest.at && now - latest.at <= FRESH_DAYS * DAY_MS;
  const forAchievement = (item) => {
    if (item.kind === "certificate") return `Certified: ${item.title}. You earned every part of it.`;
    const tier = tierInfo(item.tier).label;
    return `New badge: ${item.title}${tier ? ` (${tier})` : ""}. Well earned.`;
  };
  if (view.promoted) return `Promoted to ${view.rank.title}. Wear the new badge with pride.`;
  if (fresh) return forAchievement(latest);
  if (view.weekRank === 1) return "Top of your batch this week. Hold the lead.";
  if (view.weekRank === 2 || view.weekRank === 3) return `On the podium this week at #${view.weekRank}. Great work.`;
  if (view.weeklyXp > 0) return `${formatXp(view.weeklyXp)} XP this week. Your momentum shows.`;
  if (latest) return forAchievement(latest);
  if (!view.next) return "Elite Operator: the top of the ladder. Outstanding.";
  if (view.xp > 0) return `${formatXp(view.remaining)} XP to ${view.next.title}. Keep going.`;
  return "Your first XP is one lecture away.";
}

/**
 * The card's view model, or null when there is nothing to show (no /me data).
 * `now` is injectable for tests.
 */
export function buildRewardsView({ me, board, history, profile } = {}, { now = Date.now(), badgeLimit = 6 } = {}) {
  const summary = history?.summary || null;
  if (!me && !summary) return null;

  const xp = Math.max(0, Number(me?.xp ?? summary?.total_xp) || 0);
  const byXp = [...LEVELS].reverse().find((item) => xp >= item.min_xp);
  const rank = rankFor(me?.level || (summary?.level ? { number: Number(summary.level) } : null) || byXp);
  const nextFromApi = me ? me.next_level : undefined;
  const next = nextFromApi === undefined ? LEVELS.find((item) => item.number === rank.number + 1) || null : nextFromApi ? rankFor(nextFromApi) : null;
  const progress = levelProgress(xp, rank, next);

  const boardMe = board?.me || null;
  const weeklyXp = Math.max(0, Number(boardMe?.xp ?? me?.weekly_xp) || 0);
  const weekRank = Number(boardMe?.rank) > 0 ? Number(boardMe.rank) : null;
  const participants = Math.max(0, Number(board?.participants) || 0);

  const badgeSource = Array.isArray(me?.badges) && me.badges.length ? me.badges : Array.isArray(history?.badges) ? history.badges : [];
  const badges = badgeSource
    .filter((badge) => badge && badge.key && badge.title)
    .slice()
    .sort((a, b) => timeOf(b.earned_at) - timeOf(a.earned_at));
  const certificates = (Array.isArray(history?.certificates) ? history.certificates : []).filter((item) => item && item.valid !== false);

  const view = {
    handle: formatHandle(boardMe?.handle || profile?.handle),
    xp,
    rank,
    next,
    percent: progress.percent,
    remaining: progress.remaining,
    meter: meterSegments(progress.percent),
    weeklyXp,
    weekRank,
    participants,
    badges: badges.slice(0, badgeLimit),
    badgesCount: badges.length || Math.max(0, Number(summary?.badges_count) || 0),
    certified: certificates.length > 0,
    certificateTitle: certificates[0]?.title || certificates[0]?.type_label || "",
    promoted: Boolean(me?.level_up?.pending),
    latest: latestAchievement(badges, certificates),
  };
  return { ...view, cheer: cheerLine(view, now) };
}

/** "#3 of 24" / "Not ranked yet". */
export function weekRankLabel(view) {
  if (!view?.weekRank) return "Not ranked yet";
  return view.participants > 1 ? `#${view.weekRank} of ${view.participants}` : `#${view.weekRank}`;
}
