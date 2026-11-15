// The level-up celebration (owner, Nov 2026): what it shows and whether it is
// due. OWNER: WS-LEARN. No React here (tested directly).
//
// Detection is server-side: every award recomputes the rank; GET
// /engagement/me/ reports `level_up.pending` while the rank is above the
// highest rank the student has seen celebrated (`EngagementSummary.level_seen`).
// The UI shows the celebration once, then POSTs /engagement/me/promotion-seen/
// (idempotent; `level_seen` only ever rises). A localStorage marker keyed by
// user and rank is the client-side backstop: if that POST fails, or another
// surface still holds a stale `/me`, the same promotion is never shown twice
// on this device.
import { romanRank } from "../landing-rewards/landingRewardsModel";
import { formatXp, levelUpPending } from "./engagementModel";

const STORAGE_PREFIX = "eg:promotion-seen";

export function promotionSeenKey(userId, rankKey) {
  return `${STORAGE_PREFIX}:${userId ?? "me"}:${rankKey || ""}`;
}

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null; // blocked storage: the server marker still holds
  }
}

export function wasCelebrated(userId, rankKey, store = storage()) {
  if (!rankKey) return false;
  try {
    return store?.getItem(promotionSeenKey(userId, rankKey)) === "1";
  } catch {
    return false;
  }
}

export function rememberCelebrated(userId, rankKey, store = storage()) {
  if (!rankKey) return;
  try {
    store?.setItem(promotionSeenKey(userId, rankKey), "1");
  } catch {
    // storage full or blocked: nothing to do
  }
}

/** True when `/me` says a promotion has not been celebrated yet (and this device has not shown it). */
export function celebrationDue(me, userId, store = storage()) {
  return levelUpPending(me) && !wasCelebrated(userId, me.level.key, store);
}

/**
 * `{ rank: {number, key, title, roman}, xp, xpText, next, nextText }` for the
 * celebration card, from GET /engagement/me/.
 */
export function celebrationView(me) {
  if (!me?.level) return null;
  const number = Math.max(1, Math.min(8, Number(me.level.number) || 1));
  const xp = Math.max(0, Number(me.xp) || 0);
  const next = me.next_level || null;
  const toNext = next ? Math.max(0, Number(me.xp_to_next_level ?? next.min_xp - xp) || 0) : 0;
  return {
    rank: { number, key: me.level.key, title: me.level.title || "", roman: romanRank(number) },
    xp,
    xpText: `${formatXp(xp)} XP`,
    next: next ? { number: Number(next.number) || number + 1, title: next.title, minXp: Number(next.min_xp) || 0 } : null,
    nextText: next
      ? `${formatXp(toNext)} XP to ${next.title} (Rank ${romanRank(Number(next.number) || number + 1)} at ${formatXp(next.min_xp)} XP)`
      : "Top rank reached: the highest title on the platform.",
    progress: Math.max(0, Math.min(1, Number(me.level_progress) || 0)),
  };
}

export function prefersReducedMotion() {
  try {
    if (typeof document !== "undefined" && document.documentElement?.dataset?.motion === "reduce") return true;
    return Boolean(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}
