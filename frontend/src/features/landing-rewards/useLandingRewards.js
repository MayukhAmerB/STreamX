// Loads the signed-in student's rewards for the Friday landing, once per
// visit: the compact card under the hero and the richer card in the reward
// band share one round of requests (a module-level cache, 60 s).
// The week board + reward history half ("extras") has its own shared cache,
// also read by the Console rank header (useRewardExtras): moving between the
// landing and the Console within 60 s never repeats those two requests.
//
// Only for a signed-in STUDENT with the `engagement` switch on (capabilities);
// staff, guests and a switched-off engagement get `{ eligible: false }` and no
// request is made. Uses the existing engagement APIs only:
//   GET /engagement/me/, GET /engagement/leaderboard/?scope=batch&period=week,
//   GET /engagement/me/history/ (certificates), GET /profiles/me/ (handle
//   fallback, only when the leaderboard has none).
import { useEffect, useMemo, useState } from "react";

import { useAuth } from "../../hooks/useAuth";
import { fetchEngagementMe, fetchLeaderboard } from "../engagement-ui/engagementApi";
import { useEngagementEnabled } from "../engagement-ui/useEngagement";
import { fetchMyProfile } from "../profiles/profilesApi";
import { isStaffLike } from "../profiles/publicName";
import { fetchRewardHistory } from "../rewards/rewardsApi";
import { buildRewardsView } from "./landingRewardsModel";

const CACHE_MS = 60 * 1000;
const cache = { userId: null, promise: null, sources: null, at: 0 };
const extrasCache = { userId: null, promise: null, value: null, at: 0 };

const settledValue = (result) => (result.status === "fulfilled" ? result.value : null);

async function fetchExtras() {
  const [board, history] = await Promise.allSettled([fetchLeaderboard({ period: "week" }), fetchRewardHistory({ page: 1, pageSize: 1 })]);
  return { board: settledValue(board)?.data || null, history: settledValue(history) || null };
}

/**
 * The week board (`me.rank`, `me.handle`, `batch`, `participants`) and the
 * reward history (badges with dates, certificates) for `userId`: one shared
 * request round per user, re-used for 60 s by every caller.
 */
export function loadRewardExtras(userId) {
  const fresh = extrasCache.userId === userId && (extrasCache.promise || Date.now() - extrasCache.at < CACHE_MS);
  if (!fresh) {
    extrasCache.userId = userId;
    extrasCache.value = null;
    extrasCache.promise = fetchExtras()
      .catch(() => ({ board: null, history: null }))
      .then((value) => {
        if (extrasCache.userId === userId) {
          extrasCache.value = value;
          extrasCache.at = Date.now();
          extrasCache.promise = null;
        }
        return value;
      });
  }
  return extrasCache.promise || Promise.resolve(extrasCache.value);
}

/** The cached extras for `userId` when they are already loaded (else null). */
export function cachedRewardExtras(userId) {
  return extrasCache.userId === userId && !extrasCache.promise ? extrasCache.value : null;
}

async function loadSources(userId) {
  const [me, extras] = await Promise.allSettled([fetchEngagementMe(), loadRewardExtras(userId)]);
  const meData = settledValue(me)?.data || null;
  if (!meData) return null;
  const { board: boardData = null, history = null } = settledValue(extras) || {};
  let profile = null;
  if (!boardData?.me?.handle) {
    try {
      const mine = await fetchMyProfile();
      profile = mine?.handle ? { handle: mine.handle } : null;
    } catch {
      profile = null;
    }
  }
  return { me: meData, board: boardData, history, profile };
}

function sourcesFor(userId) {
  const fresh = cache.userId === userId && (cache.promise || Date.now() - cache.at < CACHE_MS);
  if (!fresh) {
    cache.userId = userId;
    cache.sources = null;
    cache.promise = loadSources(userId)
      .catch(() => null)
      .then((sources) => {
        if (cache.userId === userId) {
          cache.sources = sources;
          cache.at = Date.now();
          cache.promise = null;
        }
        return sources;
      });
  }
  return cache.promise || Promise.resolve(cache.sources);
}

/** Test helper: forget the shared cache. */
export function resetLandingRewardsCache() {
  cache.userId = null;
  cache.promise = null;
  cache.sources = null;
  cache.at = 0;
  extrasCache.userId = null;
  extrasCache.promise = null;
  extrasCache.value = null;
  extrasCache.at = 0;
}

/** True for a signed-in student account (never staff, instructors or admins). */
export function isStudentViewer(auth) {
  const user = auth?.user;
  if (!auth?.isAuthenticated || !user || user.id == null) return false;
  return !isStaffLike(user) && !user.is_admin && !auth.isAdmin && !auth.isInstructor;
}

/**
 * `{ eligible, status, view }`. `status`: "off" | "loading" | "ready" | "empty".
 * `view` is the landingRewardsModel view (handle only, never a real name).
 */
export default function useLandingRewards() {
  const auth = useAuth() || {};
  const engagementOn = useEngagementEnabled();
  const student = isStudentViewer(auth);
  const userId = auth.user?.id ?? null;
  const eligible = student && engagementOn;
  const cached = eligible && cache.userId === userId && cache.sources ? cache.sources : null;
  const [state, setState] = useState(() => ({ key: cached ? userId : null, sources: cached }));

  useEffect(() => {
    if (!eligible) return undefined;
    let active = true;
    sourcesFor(userId).then((sources) => {
      if (active) setState({ key: userId, sources });
    });
    return () => {
      active = false;
    };
  }, [eligible, userId]);

  const sources = eligible && state.key === userId ? state.sources : null;
  const view = useMemo(() => (sources ? buildRewardsView(sources) : null), [sources]);

  if (!eligible) return { eligible: false, student, status: "off", view: null };
  if (state.key !== userId) return { eligible: true, student, status: "loading", view: null };
  // `me`: the raw GET /engagement/me/ (the landing level-up celebration reads `level_up` from it).
  return { eligible: true, student, status: view ? "ready" : "empty", view, me: sources?.me || null };
}

/**
 * `{ status, board, history }` for the Console rank header: the shared extras
 * (loadRewardExtras), only while `enabled`. `status`: "off" | "loading" | "ready".
 */
export function useRewardExtras(userId, enabled) {
  const [state, setState] = useState(() => {
    const cached = enabled ? cachedRewardExtras(userId) : null;
    return { key: cached ? userId : null, value: cached };
  });

  useEffect(() => {
    if (!enabled || userId == null) return undefined;
    let active = true;
    loadRewardExtras(userId).then((value) => {
      if (active) setState({ key: userId, value });
    });
    return () => {
      active = false;
    };
  }, [enabled, userId]);

  if (!enabled || userId == null) return { status: "off", board: null, history: null };
  if (state.key !== userId) return { status: "loading", board: null, history: null };
  return { status: "ready", board: state.value?.board || null, history: state.value?.history || null };
}
