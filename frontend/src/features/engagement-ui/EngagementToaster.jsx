// "+20 XP" toasts from the X-Engagement header (lecture completed, report
// submitted). Mounted once by the Console shell, inside its ToastProvider.
// OWNER: WS-LEARN. The toast system announces politely, pauses on hover and
// focus, and only fades under reduced motion.
import { useEffect, useRef } from "react";
import { useToast } from "../app-shell/ui/toast";
import { formatXp } from "./engagementModel";
import LevelUpMoment from "./LevelUpMoment";
import useEngagement from "./useEngagement";

export const XP_TOAST_MS = 4000;

export default function EngagementToaster() {
  const { showToast } = useToast();
  const { gain, summary, clearGain, enabled } = useEngagement();
  const shown = useRef(0);

  useEffect(() => {
    if (!enabled || !gain || gain.id === shown.current || typeof showToast !== "function") return;
    shown.current = gain.id;
    const level = summary?.level?.title;
    showToast({
      kind: "success",
      title: `+${formatXp(gain.xp)} XP`,
      subtitle: [level, summary?.xp != null ? `${formatXp(summary.xp)} XP in total` : ""].filter(Boolean).join(" · "),
      timeout: XP_TOAST_MS,
    });
    clearGain();
  }, [gain, enabled, summary, showToast, clearGain]);

  // The once-only level-up moment rides along with the toaster (same shell mount).
  return <LevelUpMoment />;
}
