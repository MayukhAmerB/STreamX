// Loads the signed-in student's rewards for the Friday landing, once per
// visit: the compact card under the hero and the richer card in the reward
// band share one round of requests (a module-level cache, 60 s).
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

const settledValue = (result) => (result.status === "fulfilled" ? result.value : null);

async function loadSources() {
  const [me, board, history] = await Promise.allSettled([
    fetchEngagementMe(),
    fetchLeaderboard({ period: "week" }),
    fetchRewardHistory({ page: 1, pageSize: 1 }),
  ]);
  const meData = settledValue(me)?.data || null;
  if (!meData) return null;
  const boardData = settledValue(board)?.data || null;
  let profile = null;
  if (!boardData?.me?.handle) {
    try {
      const mine = await fetchMyProfile();
      profile = mine?.handle ? { handle: mine.handle } : null;
    } catch {
      profile = null;
    }
  }
  return { me: meData, board: boardData, history: settledValue(history) || null, profile };
}

function sourcesFor(userId) {
  const fresh = cache.userId === userId && (cache.promise || Date.now() - cache.at < CACHE_MS);
  if (!fresh) {
    cache.userId = userId;
    cache.sources = null;
    cache.promise = loadSources()
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
  return { eligible: true, student, status: view ? "ready" : "empty", view };
}
