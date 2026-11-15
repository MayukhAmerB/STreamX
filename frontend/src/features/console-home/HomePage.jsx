// Console Home `/console` (T1, plan §3.4). OWNER: WS-LEARN.
// One request (GET /api/console/today/) answers "what should I do next".
// The engagement summary (XP, streak) comes from the shared engagement store
// (no extra polling) and only while the `engagement` switch is on; the rank
// header at the top reads the same store (no second /me request).
import { useEffect, useMemo, useState } from "react";
import { siteBrand } from "../../config/siteBrand";
import { useAuth } from "../../hooks/useAuth";
import useCapabilities from "../capabilities/useCapabilities";
import useEngagement from "../engagement-ui/useEngagement";
import HomeView from "./HomeView";
import ConsoleRankHeader from "./RankHeader";
import useToday from "./useToday";

const CLOCK_TICK_MS = 30_000;

function useClock(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Practice-card words from capabilities: labs members-only? Pentesting purchasable? */
export function practiceFromCaps(caps, brandId = siteBrand.id) {
  const pentestingItem = caps?.items?.["pentesting-purchase"];
  const pentestingOpen = pentestingItem ? pentestingItem.state === "enabled" : Boolean(caps?.features?.pentesting?.enabled);
  return {
    brandId,
    labsMembersOnly: Boolean(caps?.features?.labs_membership_required?.enabled),
    pentestingOpen,
  };
}

export default function HomePage() {
  const auth = useAuth();
  const now = useClock(CLOCK_TICK_MS);
  const today = useToday("learn");
  const { caps } = useCapabilities();
  const engagement = useEngagement();
  const practice = useMemo(() => practiceFromCaps(caps), [caps]);
  const summary = engagement.enabled && engagement.data ? { ...engagement.data, ...(engagement.summary || {}) } : null;
  return (
    <HomeView
      user={auth?.user}
      data={today.data}
      loading={today.loading}
      showSkeleton={today.showSkeleton}
      error={today.error}
      onRetry={today.retry}
      updatedAt={today.updatedAt}
      now={now}
      engagement={summary}
      practice={practice}
      rankHeader={<ConsoleRankHeader engagement={engagement} />}
    />
  );
}
