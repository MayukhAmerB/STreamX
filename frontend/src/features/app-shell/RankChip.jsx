// Compact rank next to the user: 24 px rank emblem + the small LVL tag + the
// rank title, linking to /achievements. OWNER: WS-LEARN.
// In the Console header on desktop (beside "Jump to…", the bell and the
// avatar) and at the top of the account menu at every width (the phone header
// has no room for it). Reads the shared engagement store the shell already
// runs (no request of its own). Students only, engagement switch on.
import "./rankChip.css";

import { Link } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import useEngagement from "../engagement-ui/useEngagement";
import LevelBadge from "../landing-rewards/LevelBadge";
import { rankFor, romanRank } from "../landing-rewards/landingRewardsModel";
import RankEmblem from "../landing-rewards/RankEmblem";
import { isStudentViewer } from "../landing-rewards/useLandingRewards";

export const RANK_CHIP_PATH = "/achievements";

/** Presentational: `level` is the /me level payload (`{ number, key, title }`). */
export function RankChipView({ level, variant = "header", onNavigate }) {
  const rank = rankFor(level);
  const number = rank.number;
  return (
    <Link
      to={RANK_CHIP_PATH}
      className={`rank-chip rank-chip--${variant}`}
      aria-label={`Rank ${romanRank(number)}, ${rank.title}, level ${number}: view achievements`}
      data-rank={number}
      onClick={onNavigate}
    >
      <RankEmblem number={number} title={rank.title} size={24} decorative />
      <LevelBadge number={number} size={variant === "menu" ? 22 : 20} decorative />
      <span className="rank-chip__title">{rank.title}</span>
    </Link>
  );
}

/** Connected chip: renders nothing until the student's /me data is in. */
export default function RankChip({ variant = "header", onNavigate }) {
  const auth = useAuth() || {};
  const engagement = useEngagement();
  if (!isStudentViewer(auth) || !engagement.enabled || !engagement.data) return null;
  const level = engagement.summary?.level || engagement.data.level;
  if (!level) return null;
  return <RankChipView level={level} variant={variant} onNavigate={onNavigate} />;
}
