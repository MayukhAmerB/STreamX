// Pure view model for the Console rank header and its details panel (no
// React, no DOM). OWNER: WS-LEARN. Inputs are payloads the Console already
// holds: the engagement store's /engagement/me/ (merged with its optimistic
// summary), and the shared week board + reward history (useRewardExtras).
// Handle only, never a real name (owner privacy rule).
//
// The LVL number IS the rank number: the backend has eight ranks
// (apps/engagement/rules.py LEVELS) and no finer-grained level.
import { LEVELS, formatEarnedDate, formatXp } from "../engagement-ui/engagementModel";
import { HUE } from "../landing-rewards/insigniaPalette";
import { buildRewardsView, formatHandle, romanRank } from "../landing-rewards/landingRewardsModel";

/** CSS custom properties for the insignia energy colours (they live in insigniaPalette.js). */
export function accentVars(level) {
  const emerald = level === 6 || level >= 8;
  return { "--rh-accent": emerald ? HUE.emerald : HUE.cyan, "--rh-cyan": HUE.cyan, "--rh-emerald": HUE.emerald };
}

/** What each rank means (the panel's "what it means" line). */
export const RANK_MEANINGS = Object.freeze({
  recruit: "Where every student starts. Your XP, streak and place on the batch leaderboard count from your first lecture.",
  operative: "You turn up and do the work: live classes, lectures and weekly reports have carried you past the first threshold.",
  operator: "Steady week after week. Your study habits now carry you through the course.",
  analyst: "You work cases like an investigator: consistent classes, reports and practice.",
  specialist: "Deep, dependable work. A student the rest of the batch looks to.",
  senior_analyst: "Among the most committed students in the academy: months of classes, reports and labs.",
  lead_investigator: "Few students reach this rank. You lead by example in every part of the course.",
  elite_operator: "The top of the ladder: the highest rank the academy awards.",
});

/** What a rank unlocks (mirrors backend rules.LEVEL_UNLOCKS). */
export function rankUnlocks(rank) {
  if (!rank || rank.number <= 1) return ["Your XP, streak and batch leaderboard place"];
  return [rank.number >= 8 ? "The highest rank title on your profile and batch leaderboards" : "Rank title on your profile and batch leaderboards", "Rank certificate anyone can verify"];
}

export function levelMeaning(level) {
  const number = Math.max(1, Math.min(8, Number(level) || 1));
  return `Your level is your rank number: LVL ${number} is rank ${romanRank(number)} of 8. It goes up each time your total XP crosses the next rank's threshold.`;
}

/** "Batch III" from the board's batch (`{ title, batch }`), else the course title. */
export function batchName(batch) {
  const text = String(batch?.batch || "").trim();
  if (text) return /^batch\b/i.test(text) ? text : `Batch ${text}`;
  return String(batch?.title || "").trim() || "your batch";
}

/** "#3 in Batch III" ("" when the student has no place this week). */
export function positionLabel(rank, batch) {
  const place = Number(rank);
  return place > 0 ? `#${place} in ${batchName(batch)}` : "";
}

/**
 * When the current rank was reached: the `kind: "level"` achievement for the
 * rank's key, from /me `recent_achievements` or the achievements list.
 * Returns an ISO string or "".
 */
export function levelEarnedAt(rank, ...lists) {
  if (!rank?.key) return "";
  for (const list of lists) {
    const match = (Array.isArray(list) ? list : []).find((item) => item?.kind === "level" && item.key === rank.key && item.valid !== false);
    if (match?.earned_at) return match.earned_at;
  }
  return "";
}

/** "Starting rank" (Recruit), "Earned 14 Nov 2026", or "" while unknown. */
export function earnedLabel(rank, earnedAt) {
  if (!rank || rank.number <= 1) return "Starting rank";
  const date = formatEarnedDate(earnedAt);
  return date ? `Earned ${date}` : "";
}

/**
 * The /me payload to read: server values, with the optimistic XP/level from
 * an X-Engagement header when newer (then the next rank is re-derived from
 * the ladder, since the server's `next_level` belongs to the old level).
 */
export function mergeMe(data, summary) {
  if (!data) return null;
  if (!summary?.pending) return data;
  return { ...data, xp: summary.xp ?? data.xp, level: summary.level || data.level, next_level: undefined };
}

/**
 * The header + panel view, or null when there is no /me data yet.
 * `user` (auth) supplies the handle first; the board's handle is the fallback.
 */
export function buildConsoleRankView({ me, board = null, history = null, user = null } = {}, { now = Date.now() } = {}) {
  if (!me) return null;
  const base = buildRewardsView({ me, board, history, profile: null }, { now, badgeLimit: 200 });
  if (!base) return null;
  const { rank, next } = base;
  const earnedAt = levelEarnedAt(rank, me.recent_achievements);
  return {
    ...base,
    handle: formatHandle(user?.handle) || base.handle,
    level: rank.number,
    roman: romanRank(rank.number),
    latestBadges: base.badges.slice(0, 3),
    position: positionLabel(base.weekRank, board?.batch),
    xpLine: next ? `${formatXp(base.xp)} / ${formatXp(next.min_xp)} XP` : `${formatXp(base.xp)} XP`,
    toNext: next ? `${formatXp(base.remaining)} XP to ${next.title}` : "Top rank",
    meaning: RANK_MEANINGS[rank.key] || "",
    unlocks: rankUnlocks(rank),
    earnedAt,
    earned: earnedLabel(rank, earnedAt),
    ladder: LEVELS.map((item) => ({ ...item, state: item.number === rank.number ? "current" : item.number < rank.number ? "reached" : "ahead" })),
  };
}
