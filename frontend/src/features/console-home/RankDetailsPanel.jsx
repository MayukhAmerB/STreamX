// Rank / level details: opened from either badge of the Console rank header.
// OWNER: WS-LEARN. The kit Dialog (Radix): focus trap, Esc, background scroll
// lock, role="dialog" + aria-modal, labelled by its heading. A centred modal
// from 672 px, a bottom sheet below (rankHeader.css). Focus returns to the
// badge that opened it (explicitly: Safari does not focus a clicked button).
//
// Shows the badge large, what it means, when it was earned, total XP and the
// meter, how to earn XP (incl. the report-mark bonus), the eight ranks with
// the current one highlighted, and the student's badges with dates.
// The level date comes from /me `recent_achievements`; only when it is not
// there (an older promotion) is GET /engagement/achievements/ read, once,
// while the panel is open.
import { Close } from "@carbon/icons-react";
import { Link } from "react-router-dom";

import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../kit/Dialog";
import { BadgeMedal } from "../engagement-ui/EngagementParts";
import { fetchMyAchievements } from "../engagement-ui/engagementApi";
import { formatEarnedDate, formatXp, tierInfo } from "../engagement-ui/engagementModel";
import useEngagementResource from "../engagement-ui/useEngagementResource";
import { REWARDS_PATH, SegmentedMeter } from "../landing-rewards/LandingRewardsCard";
import LevelBadge from "../landing-rewards/LevelBadge";
import RankEmblem from "../landing-rewards/RankEmblem";
import { REPORT_BASE_XP, REPORT_BONUS_NOTE, REPORT_MARK_BONUS, WEEKLY_PRIZES, XP_WAYS } from "../rewards/rewardsContent";
import { accentVars, earnedLabel, levelEarnedAt, levelMeaning } from "./rankHeaderModel";

function Section({ title, children, className = "" }) {
  return (
    <section className={`rh-panel__section ${className}`.trim()}>
      <h3 className="rh-panel__heading">{title}</h3>
      {children}
    </section>
  );
}

/** The key XP rules, from the public rewards copy (rewardsContent). */
export function EarnRules() {
  return (
    <>
      <ul className="rh-earn">
        {XP_WAYS.map((way) => (
          <li key={way.key} className="rh-earn__row">
            <span className="rh-earn__xp">{way.value}</span>
            <span className="rh-earn__label">
              {way.label}
              {way.note ? <span className="rh-earn__note">{way.note}</span> : null}
            </span>
          </li>
        ))}
        <li className="rh-earn__row">
          <span className="rh-earn__xp">{REPORT_BASE_XP.submitted} XP</span>
          <span className="rh-earn__label">
            Weekly report
            <span className="rh-earn__note">
              {REPORT_BASE_XP.onTime} XP when it is on time, plus a mark bonus
            </span>
          </span>
        </li>
      </ul>
      <table className="rh-bonus">
        <caption className="rh-bonus__caption">Report mark bonus, on top of the report XP</caption>
        <thead>
          <tr>
            <th scope="col">Mark</th>
            <th scope="col">Bonus</th>
            <th scope="col" className="rh-bonus__label-col">
              Grade
            </th>
          </tr>
        </thead>
        <tbody>
          {REPORT_MARK_BONUS.map((row) => (
            <tr key={row.score}>
              <th scope="row">{row.score}/10</th>
              <td className="rh-bonus__xp">+{formatXp(row.xp)} XP</td>
              <td className="rh-bonus__label-col">{row.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rh-panel__note">{REPORT_BONUS_NOTE}</p>
      <p className="rh-panel__note">
        Weekly leaderboard prizes: {WEEKLY_PRIZES.map((prize) => `${prize.place} ${prize.xp}`).join(" · ")}.
      </p>
    </>
  );
}

/** All eight ranks, the current one highlighted. */
export function RankLadderStrip({ ladder }) {
  return (
    <ol className="rh-ladder" aria-label="The eight ranks">
      {ladder.map((item) => (
        <li
          key={item.key}
          className={`rh-ladder__rank is-${item.state}`}
          aria-current={item.state === "current" ? "step" : undefined}
          data-rank={item.number}
        >
          <RankEmblem number={item.number} title={item.title} size={48} decorative animated={false} />
          <span className="rh-ladder__title">{item.title}</span>
          <span className="rh-ladder__xp">{formatXp(item.min_xp)} XP</span>
          {item.state === "current" ? <span className="rh-ladder__here">You are here</span> : null}
          {item.state === "reached" ? <span className="sr-only">(reached)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function EarnedBadges({ badges }) {
  if (!badges.length) {
    return <p className="rh-panel__note">No badges yet. Finish a lecture, a live class or a weekly report to earn your first.</p>;
  }
  return (
    <ul className="rh-earned">
      {badges.map((badge) => {
        const tier = tierInfo(badge.tier).label;
        const date = formatEarnedDate(badge.earned_at);
        return (
          <li key={badge.key} className="rh-earned__item">
            <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned size={40} />
            <span className="rh-earned__text">
              <span className="rh-earned__title">{badge.title}</span>
              <span className="rh-earned__meta">{[tier, date ? `Earned ${date}` : ""].filter(Boolean).join(" · ")}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * `view`: rankHeaderModel view. `kind`: "rank" | "level" (which badge was
 * pressed). `returnFocusRef`: the badge button to focus again on close.
 */
export default function RankDetailsPanel({ view, kind = "rank", open, onClose, returnFocusRef }) {
  const { rank, roman, level } = view;
  const needsDate = open && level > 1 && !view.earnedAt;
  const achievements = useEngagementResource(fetchMyAchievements, { enabled: needsDate, key: `${rank.key}` });
  const earnedAt = view.earnedAt || levelEarnedAt(rank, achievements.data?.achievements);
  const earned = earnedLabel(rank, earnedAt) || (needsDate && achievements.status === "loading" ? "Checking when you earned it…" : "");
  const isLevel = kind === "level";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="rh-panel"
        aria-modal="true"
        hideClose
        style={accentVars(level)}
        data-testid="rank-details-panel"
        data-kind={kind}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (target && typeof target.focus === "function") {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        <div className="rh-panel__bar">
          <span className="rh-panel__grip" aria-hidden="true" />
          <DialogClose className="rh-panel__close" aria-label="Close details">
            <Close size={20} aria-hidden="true" />
          </DialogClose>
        </div>

        <header className="rh-panel__hero">
          <div className="rh-panel__badge">
            {isLevel ? (
              <LevelBadge number={level} title={rank.title} size={148} detail="full" />
            ) : (
              <RankEmblem number={level} title={rank.title} size={188} detail="full" shine />
            )}
          </div>
          <div className="rh-panel__intro">
            <p className="rh-panel__eyebrow">{isLevel ? `Your level · Rank ${roman} of 8` : `Your rank · Rank ${roman} of 8`}</p>
            <DialogTitle className="rh-panel__title">{isLevel ? `Level ${level}` : rank.title}</DialogTitle>
            <p className="rh-panel__sub">
              <span>{isLevel ? `${rank.title} · Rank ${roman}` : `LVL ${level}`}</span>
              {earned ? <span className="rh-panel__earned">{earned}</span> : null}
            </p>
            <DialogDescription className="rh-panel__meaning">{isLevel ? levelMeaning(level) : view.meaning}</DialogDescription>
            {!isLevel && view.unlocks.length ? (
              <ul className="rh-panel__unlocks" aria-label="What this rank unlocks">
                {view.unlocks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </header>

        <Section title="Your XP">
          <p className="rh-panel__total">
            <span className="rh-panel__total-xp">{formatXp(view.xp)}</span> XP in total
          </p>
          <SegmentedMeter view={view} />
          <p className="rh-panel__legend">
            <span>{view.xpLine}</span>
            <span className="rh-panel__legend-next">{view.next ? (isLevel ? `${view.toNext} (LVL ${level + 1})` : view.toNext) : "Top rank reached"}</span>
          </p>
        </Section>

        <Section title="How to earn XP">
          <EarnRules />
        </Section>

        <Section title="The eight ranks">
          <RankLadderStrip ladder={view.ladder} />
        </Section>

        <Section title={`Your badges${view.badgesCount ? ` · ${view.badgesCount} earned` : ""}`}>
          <EarnedBadges badges={view.badges} />
        </Section>

        <div className="rh-panel__footer">
          <Link to={REWARDS_PATH} className="rh-panel__cta" onClick={onClose}>
            View achievements
          </Link>
        </div>
      </DialogContent>
    </Dialog>
  );
}
