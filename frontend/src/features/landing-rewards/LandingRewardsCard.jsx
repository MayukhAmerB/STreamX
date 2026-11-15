// "Your progress": the signed-in student's own rewards on the Friday landing.
// `compact` sits right under the hero; `full` sits inside the reward band at
// the end of the landing. Both read useLandingRewards (one shared request
// round). Renders nothing for guests, staff, or when engagement is off.
// Handle only, never a real name. The "Certified" mark is a badge; only the
// owner's own card links to their profile Certificates tab.
import { useId } from "react";
import { Link } from "react-router-dom";

import { BadgeMedal } from "../engagement-ui/EngagementParts";
import { formatXp, tierInfo } from "../engagement-ui/engagementModel";
import { romanRank, weekRankLabel } from "./landingRewardsModel";
import RankEmblem from "./RankEmblem";
import useLandingRewards from "./useLandingRewards";
import "./landingRewards.css";

export const REWARDS_PATH = "/achievements";
export const CERTIFICATES_PATH = "/profile/public?tab=certificates";
const LEADERBOARD_PATH = "/leaderboard";

const primaryLink =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black";
const secondaryLink =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-5 text-sm font-semibold text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
const eyebrow = "text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9E9E9E]";

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" className="fill-none stroke-current">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The "Certified" seal: a badge only (no certificate details for anyone else). */
export function CertifiedBadge({ href = "", title = "" }) {
  const body = (
    <>
      <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
        <path
          d="M10 1.5 12.1 3l2.6-.2.8 2.5 2.1 1.5-.8 2.5.8 2.5-2.1 1.5-.8 2.5-2.6-.2L10 18.5 7.9 17l-2.6.2-.8-2.5-2.1-1.5.8-2.5-.8-2.5 2.1-1.5.8-2.5 2.6.2Z"
          fill="#ffffff"
        />
        <path d="m6.6 10.2 2.2 2.2 4.6-4.8" fill="none" stroke="#0a0a0a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Certified</span>
    </>
  );
  const className =
    "inline-flex items-center gap-1.5 rounded-full border border-white/35 bg-white/[0.08] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white";
  if (href) {
    return (
      <Link
        to={href}
        className={`${className} transition hover:bg-white/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70`}
        title={title ? `${title}: open your certificates` : "Open your certificates"}
      >
        {body}
      </Link>
    );
  }
  return <span className={className}>{body}</span>;
}

/** Segmented meter to the next rank (10 segments; the current one is partly lit). */
export function SegmentedMeter({ view }) {
  const label = view.next
    ? `${view.percent}% of the way from ${view.rank.title} to ${view.next.title}`
    : `${view.rank.title}: top rank reached`;
  const fractions = view.next ? view.meter.fractions : view.meter.fractions.map(() => 1);
  return (
    <div className="lr-meter" role="img" aria-label={label} data-filled={view.meter.filled}>
      {fractions.map((fraction, index) => (
        <span key={index} className="lr-meter__seg">
          {fraction > 0 ? <span className="lr-meter__fill" style={{ "--lr-f": fraction, "--lr-i": index }} /> : null}
        </span>
      ))}
    </div>
  );
}

function BadgeRow({ badges, size = 40, withTitles = false }) {
  if (!badges.length) {
    return <p className="text-xs text-[#8F8F8F]">Your first badge is waiting: finish a lecture to earn it.</p>;
  }
  if (withTitles) {
    return (
      <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {badges.map((badge, index) => (
          <li
            key={badge.key}
            className="lr-badge flex min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-[#0A0A0A] px-2 py-2 sm:gap-3 sm:px-3 sm:py-2.5"
            style={{ "--lr-i": index }}
          >
            <span className="flex flex-none [&>svg]:h-7 [&>svg]:w-7 sm:[&>svg]:h-auto sm:[&>svg]:w-auto">
              <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned size={size} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-white sm:text-sm">{badge.title}</span>
              <span className="block text-[10px] uppercase tracking-[0.12em] text-[#8F8F8F] sm:text-[11px]">{tierInfo(badge.tier).label || "Badge"}</span>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Latest badges">
      {badges.map((badge, index) => (
        <li
          key={badge.key}
          className="lr-badge flex items-center justify-center rounded-xl border border-white/10 bg-[#0A0A0A] p-1.5"
          style={{ "--lr-i": index }}
          title={`${badge.title}${tierInfo(badge.tier).label ? ` (${tierInfo(badge.tier).label})` : ""}`}
        >
          <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned size={size} />
          <span className="sr-only">{badge.title}</span>
        </li>
      ))}
    </ul>
  );
}

function StatCells({ items }) {
  return (
    <dl className="grid grid-cols-3 overflow-hidden rounded-2xl border border-white/10 bg-[#090909]">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-r border-white/10 px-2.5 py-3 last:border-r-0 sm:px-4">
          <dt className="whitespace-nowrap text-[9px] font-semibold uppercase tracking-[0.1em] text-[#8F8F8F] min-[400px]:text-[10px] sm:tracking-[0.16em]">{item.label}</dt>
          <dd className="mt-1 break-words font-reference text-base font-semibold leading-tight tabular-nums text-white min-[400px]:text-lg sm:text-xl">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function statItems(view) {
  return [
    { label: "Total XP", value: formatXp(view.xp) },
    { label: "This week", value: `+${formatXp(view.weeklyXp)}` },
    { label: "Week rank", value: weekRankLabel(view) },
  ];
}

function MeterLegend({ view }) {
  return (
    <p className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-[#9E9E9E]">
      <span>
        Rank {romanRank(view.rank.number)} · {view.rank.title}
      </span>
      <span className="font-semibold text-[#D4D4D4]">
        {view.next ? `${formatXp(view.remaining)} XP to ${view.next.title}` : "Top rank reached"}
      </span>
    </p>
  );
}

function Identity({ view, headingId, headingTag: Heading = "h2", size }) {
  return (
    <div className="flex min-w-0 items-center gap-4">
      <RankEmblem number={view.rank.number} title={view.rank.title} size={size} shine />
      <div className="min-w-0">
        <p className={eyebrow}>Your progress</p>
        <Heading id={headingId} className="mt-1 truncate font-reference text-xl font-semibold tracking-tight text-white sm:text-2xl">
          {view.handle || "Your rank"}
        </Heading>
        <p className="mt-0.5 text-sm text-[#BDBDBD]">
          <span className="font-semibold text-white">{view.rank.title}</span>
          <span className="text-[#8F8F8F]"> · Rank {romanRank(view.rank.number)} of 8</span>
        </p>
        {view.certified ? (
          <div className="mt-2">
            <CertifiedBadge href={CERTIFICATES_PATH} title={view.certificateTitle} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Cheer({ view }) {
  return (
    <p className="text-sm font-medium leading-6 text-[#E0E0E0]" aria-live="polite">
      {view.cheer}
    </p>
  );
}

function Skeleton({ variant, className }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading your progress"
      className={`rounded-[22px] border border-white/10 bg-[#070707] ${variant === "full" ? "min-h-[360px]" : "min-h-[248px] lg:min-h-[176px]"} ${className}`}
    />
  );
}

function CompactCard({ view, className }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="landing-rewards-card"
      className={`lr-card relative overflow-hidden rounded-[22px] border border-white/10 bg-[#070707] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-6 ${className}`}
    >
      <div aria-hidden="true" className="lr-card__glow pointer-events-none absolute inset-0" />
      <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-8">
        <Identity view={view} headingId={headingId} size={84} />
        <StatCells items={statItems(view)} />
      </div>
      <div className="relative mt-5">
        <SegmentedMeter view={view} />
        <MeterLegend view={view} />
      </div>
      <div className="relative mt-5 flex flex-col gap-4 border-t border-white/10 pt-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 lg:max-w-[48%]">
          <Cheer view={view} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-end">
          <BadgeRow badges={view.badges.slice(0, 4)} size={30} />
          <Link to={REWARDS_PATH} className={`${primaryLink} w-full sm:w-auto`}>
            View all rewards
            <Arrow />
          </Link>
        </div>
      </div>
    </section>
  );
}

function FullCard({ view, className }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="landing-rewards-full"
      className={`lr-card relative overflow-hidden rounded-2xl border border-white/15 bg-[#0A0A0A] p-4 sm:p-6 ${className}`}
    >
      <div aria-hidden="true" className="lr-card__glow pointer-events-none absolute inset-0" />
      <div className="relative grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:gap-8">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-[#070707] px-4 py-6 text-center">
          <RankEmblem number={view.rank.number} title={view.rank.title} size={132} shine />
          <p className={`${eyebrow} mt-4`}>Rank {romanRank(view.rank.number)} of 8</p>
          <h3 id={headingId} className="mt-1 font-reference text-2xl font-semibold tracking-tight text-white">
            {view.rank.title}
          </h3>
          {view.handle ? <p className="mt-1 max-w-full truncate text-sm text-[#BDBDBD]">{view.handle}</p> : null}
          {view.certified ? (
            <div className="mt-3">
              <CertifiedBadge href={CERTIFICATES_PATH} title={view.certificateTitle} />
            </div>
          ) : null}
        </div>

        <div className="min-w-0">
          <Cheer view={view} />
          <div className="mt-4">
            <StatCells items={statItems(view)} />
          </div>
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className={eyebrow}>Next rank</span>
              {view.next ? (
                <span className="flex items-center gap-2 text-xs text-[#BDBDBD]">
                  <RankEmblem number={view.next.number} title={view.next.title} size={22} />
                  {view.next.title} at {formatXp(view.next.min_xp)} XP
                </span>
              ) : null}
            </div>
            <SegmentedMeter view={view} />
            <MeterLegend view={view} />
          </div>
          <div className="mt-5">
            <p className={`${eyebrow} mb-3`}>
              Latest badges{view.badgesCount ? ` · ${view.badgesCount} earned` : ""}
            </p>
            <BadgeRow badges={view.badges} size={34} withTitles />
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Link to={REWARDS_PATH} className={primaryLink}>
              View all rewards
              <Arrow />
            </Link>
            <Link to={LEADERBOARD_PATH} className={secondaryLink}>
              Weekly leaderboard
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * `variant`: "compact" (under the hero) | "full" (inside the reward band).
 * `className` lands on the card itself, so nothing (not even spacing) renders
 * for guests, staff, or when engagement is off.
 */
export default function LandingRewardsCard({ variant = "compact", className = "" }) {
  const rewards = useLandingRewards();
  if (!rewards.eligible) return null;
  if (rewards.status === "loading") return <Skeleton variant={variant} className={className} />;
  if (rewards.status !== "ready" || !rewards.view) return null;
  return variant === "full" ? <FullCard view={rewards.view} className={className} /> : <CompactCard view={rewards.view} className={className} />;
}
