// Console rank header: the first thing a student sees on /console (owner
// item 5: "the reward badge should also be visible at the very start of the
// Console", as a BIG badge, the hero of the header). OWNER: WS-LEARN.
//
// A medal pair (rank emblem + LVL badge, each a button that opens the details
// panel), the rank and Roman numeral, the @handle, a 10-segment meter to the
// next rank, this week's XP, the batch position, the latest 3 badges and the
// "Certified" seal. The rest of the card links to /achievements (one stretched
// link, so no control is nested inside another).
// Presentational: `view` comes from useConsoleRank (rankHeaderModel).
import "./rankHeader.css";
import "../landing-rewards/landingRewards.css";

import { ArrowRight } from "@carbon/icons-react";
import { useCallback, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { BadgeMedal } from "../engagement-ui/EngagementParts";
import { formatXp, tierInfo } from "../engagement-ui/engagementModel";
import { CertifiedBadge, REWARDS_PATH, SegmentedMeter } from "../landing-rewards/LandingRewardsCard";
import LevelBadge from "../landing-rewards/LevelBadge";
import RankEmblem from "../landing-rewards/RankEmblem";
import RankDetailsPanel from "./RankDetailsPanel";
import { accentVars } from "./rankHeaderModel";
import useConsoleRank from "./useConsoleRank";

function LatestBadges({ badges }) {
  if (!badges.length) return <span className="rh__muted">Your first badge is one lecture away</span>;
  return (
    <ul className="rh__badges" aria-label="Latest badges">
      {badges.map((badge) => {
        const tier = tierInfo(badge.tier).label;
        return (
          <li key={badge.key} className="rh__badge" title={`${badge.title}${tier ? ` (${tier})` : ""}`}>
            <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned size={34} />
            <span className="sr-only">{badge.title}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function RankHeaderSkeleton() {
  return (
    <div className="rh rh--skeleton" aria-busy="true" role="status" data-testid="console-rank-header-skeleton">
      <span className="sr-only">Loading your rank</span>
      <span className="rh__ghost rh__ghost--medal" aria-hidden="true" />
      <span className="rh__ghost-lines" aria-hidden="true">
        <span className="rh__ghost rh__ghost--line" />
        <span className="rh__ghost rh__ghost--title" />
        <span className="rh__ghost rh__ghost--meter" />
      </span>
    </div>
  );
}

/**
 * `view`: rankHeaderModel.buildConsoleRankView(). `initialPanel` ("rank" |
 * "level") opens the details panel on first render (the dev gallery uses it).
 */
export function RankHeader({ view, initialPanel = null }) {
  const headingId = useId();
  const [panel, setPanel] = useState({ kind: initialPanel || "rank", open: Boolean(initialPanel) });
  const rankButton = useRef(null);
  const levelButton = useRef(null);
  const returnFocus = useRef(null);
  const close = useCallback(() => setPanel((current) => ({ ...current, open: false })), []);
  if (!view) return null;
  const open = (kind) => {
    returnFocus.current = kind === "level" ? levelButton.current : rankButton.current;
    setPanel({ kind, open: true });
  };
  const { rank, roman, level } = view;

  return (
    <section className="rh" aria-labelledby={headingId} data-testid="console-rank-header" data-rank={level} style={accentVars(level)}>
      <span className="rh__frame" aria-hidden="true" />
      <div className="rh__medals">
        <button
          ref={rankButton}
          type="button"
          className="rh__medal rh__medal--rank"
          aria-haspopup="dialog"
          aria-label={`Rank ${roman}, ${rank.title}: open rank details`}
          onClick={() => open("rank")}
        >
          <RankEmblem number={level} title={rank.title} size={184} detail="full" shine decorative />
        </button>
        <button
          ref={levelButton}
          type="button"
          className="rh__medal rh__medal--level"
          aria-haspopup="dialog"
          aria-label={`Level ${level}: open level details`}
          onClick={() => open("level")}
        >
          <LevelBadge number={level} title={rank.title} size={112} detail="full" decorative />
        </button>
      </div>

      <div className="rh__body">
        <p className="rh__eyebrow">
          <span className="rh__rule" aria-hidden="true" />
          Your rank · Rank {roman} of 8
        </p>
        <div className="rh__headline">
          <h2 id={headingId} className="rh__title">
            {rank.title}
          </h2>
          <span className="rh__roman" aria-hidden="true">
            {roman}
          </span>
          <span className="rh__lvl">LVL {level}</span>
          {view.certified ? (
            <span className="rh__certified">
              <CertifiedBadge />
            </span>
          ) : null}
        </div>
        {view.handle ? <p className="rh__handle">{view.handle}</p> : null}

        <div className="rh__progress">
          <p className="rh__progress-line">
            <span className="rh__xp">{view.xpLine}</span>
            <span className="rh__to-next">{view.toNext}</span>
          </p>
          <SegmentedMeter view={view} />
        </div>

        <dl className="rh__stats">
          <div className="rh__stat">
            <dt>This week</dt>
            <dd>+{formatXp(view.weeklyXp)} XP</dd>
          </div>
          {view.position ? (
            <div className="rh__stat">
              <dt>Leaderboard</dt>
              <dd>{view.position}</dd>
            </div>
          ) : null}
          <div className="rh__stat rh__stat--badges">
            <dt>Latest badges</dt>
            <dd>
              <LatestBadges badges={view.latestBadges} />
            </dd>
          </div>
        </dl>

        <Link to={REWARDS_PATH} className="rh__link">
          View achievements
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>

      <RankDetailsPanel view={view} kind={panel.kind} open={panel.open} onClose={close} returnFocusRef={returnFocus} />
    </section>
  );
}

/**
 * The connected header for /console: nothing for staff, guests or a
 * switched-off engagement; a quiet skeleton while /me loads.
 */
export default function ConsoleRankHeader({ engagement }) {
  const rank = useConsoleRank(engagement);
  if (rank.status === "off") return null;
  if (rank.status === "loading") return <RankHeaderSkeleton />;
  return <RankHeader view={rank.view} />;
}
