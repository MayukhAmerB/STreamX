// Data for the Console rank header. OWNER: WS-LEARN.
// No request of its own for /me: it reads the engagement store the Console
// already runs (useEngagement, refcounted, ETag re-validation). The week board
// and reward history come from the shared extras cache (useRewardExtras, the
// same one the landing "Your progress" card reads), so neither is fetched twice.
// Students only, with the `engagement` switch on; everyone else gets "off".
import { useMemo } from "react";

import { useAuth } from "../../hooks/useAuth";
import { isStudentViewer, useRewardExtras } from "../landing-rewards/useLandingRewards";
import { buildConsoleRankView, mergeMe } from "./rankHeaderModel";

/**
 * `engagement`: the useEngagement() result the page already holds.
 * Returns `{ status, view }`; `status`: "off" | "loading" | "ready".
 */
export default function useConsoleRank(engagement) {
  const auth = useAuth() || {};
  const user = auth.user || null;
  const userId = user?.id ?? null;
  const status = engagement?.status || "off";
  const on = isStudentViewer(auth) && Boolean(engagement?.enabled) && status !== "off" && status !== "disabled";
  const extras = useRewardExtras(userId, on);
  const data = on ? engagement?.data || null : null;
  const summary = engagement?.summary || null;
  const pending = Boolean(summary?.pending);
  const optimisticXp = summary?.xp;
  const optimisticLevel = summary?.level;

  const view = useMemo(() => {
    if (!data) return null;
    const me = mergeMe(data, pending ? { pending, xp: optimisticXp, level: optimisticLevel } : null);
    return buildConsoleRankView({ me, board: extras.board, history: extras.history, user });
  }, [data, pending, optimisticXp, optimisticLevel, extras.board, extras.history, user]);

  if (!on) return { status: "off", view: null };
  if (view) return { status: "ready", view };
  return { status: status === "error" ? "off" : "loading", view: null };
}
