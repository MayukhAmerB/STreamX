// Reward-system graphics in the Friday website style (black panels, white
// hairlines, grey copy; no gold). Ported from the 13ca6b79 landing Rewards
// section: the rank ladder (real thresholds from engagementModel.LEVELS),
// the four XP cards, the code-built rank/meter/leaderboard mock and the
// weekly-prize podium. Shared by the landing band and /rewards.
import { LEVELS } from "../engagement-ui/engagementModel";
import RankEmblem from "../landing-rewards/RankEmblem";
import {
  MOCK_BOARD,
  MOCK_STUDENT,
  REPORT_BASE_XP,
  REPORT_BONUS_NOTE,
  REPORT_MARK_BONUS,
  WEEKLY_PRIZES,
  XP_WAYS,
} from "./rewardsContent";

const xpFormat = new Intl.NumberFormat("en-IN");
export const formatRewardXp = (value) => xpFormat.format(Math.max(0, Math.round(Number(value) || 0)));

export function RewardsEyebrow({ children }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#AFAFAF]">{children}</p>
  );
}

/** The eight ranks, Recruit → Elite Operator, each with its XP threshold. */
export function RankLadder({ title = "Eight ranks", note }) {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="font-reference text-xl font-semibold text-white">{title}</h3>
        {note ? <p className="text-sm text-[#9E9E9E]">{note}</p> : null}
      </div>
      <ol
        aria-label={title}
        className="mt-4 grid grid-cols-2 overflow-hidden rounded-2xl border-l border-t border-white/10 bg-[#090909] sm:grid-cols-4 xl:grid-cols-8"
      >
        {LEVELS.map((level) => (
          <li
            key={level.key}
            className="flex min-h-[148px] flex-col border-b border-r border-white/10 p-4"
          >
            <RankEmblem number={level.number} title={level.title} size={56} decorative />
            <span className="mt-3 text-sm font-semibold leading-tight text-white">{level.title}</span>
            <span className="mt-1 text-xs text-[#9E9E9E]">{formatRewardXp(level.min_xp)} XP</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** How XP is earned: the four cards. */
export function XpWays({ title = "How XP is earned", items = XP_WAYS }) {
  return (
    <div>
      <h3 className="font-reference text-xl font-semibold text-white">{title}</h3>
      <ul className="mt-4 grid grid-cols-2 gap-2 sm:gap-3">
        {items.map((item) => (
          <li key={item.key} className="flex flex-col rounded-2xl border border-white/10 bg-[#0A0A0A] p-4 sm:p-5">
            <span className="font-reference text-xl font-semibold text-white sm:text-2xl">{item.value}</span>
            <span className="mt-2 text-sm font-semibold text-[#E0E0E0]">{item.label}</span>
            <span className="mt-1 text-xs leading-5 text-[#999999]">{item.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Weekly report XP: the submission XP plus the mark-bonus tiers (score out of
 * 10). Shared by the landing band, /rewards and the Console achievements page.
 */
export function ReportBonusTiers({ title = "Weekly report bonus", className = "" }) {
  const top = REPORT_MARK_BONUS[0];
  return (
    <div className={`rounded-2xl border border-white/10 bg-[#0A0A0A] p-4 sm:p-5 ${className}`} data-testid="report-bonus-tiers">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-reference text-xl font-semibold text-white">{title}</h3>
        <span className="text-xs text-[#999999]">
          Up to {formatRewardXp(REPORT_BASE_XP.onTime + top.xp)} XP a report
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">
        Every report earns {REPORT_BASE_XP.submitted} XP ({REPORT_BASE_XP.onTime} on time). Your mark out of 10 adds a bonus:
      </p>
      <ol className="mt-4 grid grid-cols-5 gap-1.5 sm:gap-2" aria-label="Report mark bonus by score">
        {REPORT_MARK_BONUS.map((tier, index) => (
          <li
            key={tier.score}
            className={`flex flex-col items-center rounded-xl border px-1 py-3 text-center ${
              index === 0 ? "border-white/40 bg-white/[0.07]" : "border-white/10 bg-[#090909]"
            }`}
          >
            <span className="font-reference text-base font-semibold text-white sm:text-lg">{tier.score}/10</span>
            <span className="mt-1 font-mono text-xs font-semibold text-[#E0E0E0] sm:text-sm">+{formatRewardXp(tier.xp)}</span>
            <span className="mt-1 hidden text-[11px] leading-4 text-[#8E8E8E] sm:block">{tier.label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-5 text-[#999999]">{REPORT_BONUS_NOTE}</p>
    </div>
  );
}

/** Segmented XP meter: `filled` of `segments` lit. */
export function XpMeter({ filled, segments = 10, label }) {
  return (
    <div role="img" aria-label={label} className="grid grid-cols-10 gap-1">
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          data-on={index < filled ? "true" : undefined}
          className={`h-2.5 rounded-sm ${index < filled ? "bg-white" : "bg-white/10"}`}
        />
      ))}
    </div>
  );
}

/** Code-built example: a rank chip, a segmented XP meter and a leaderboard row (handles only). */
export function RewardsMock() {
  const current = LEVELS[2];
  const next = LEVELS[3];
  const xp = MOCK_STUDENT.xp;
  const segments = 10;
  const filled = Math.round(((xp - current.min_xp) / (next.min_xp - current.min_xp)) * segments);
  return (
    <figure
      aria-label="Example: a student's rank, XP and leaderboard row"
      className="flex flex-col rounded-2xl border border-white/10 bg-[#0A0A0A] p-5"
    >
      <RewardsEyebrow>Your rank</RewardsEyebrow>
      <div className="mt-3 flex items-center gap-3">
        <RankEmblem number={current.number} title={current.title} size={44} decorative />
        <span className="font-reference text-lg font-semibold text-white">{current.title}</span>
        <span className="ml-auto text-sm font-semibold text-[#D4D4D4]">{formatRewardXp(xp)} XP</span>
      </div>
      <div className="mt-4">
        <XpMeter filled={filled} segments={segments} label={`${filled} of ${segments} segments to ${next.title}`} />
      </div>
      <p className="mt-2 flex justify-between gap-3 text-xs text-[#9E9E9E]">
        <span>{current.title}</span>
        <span>
          {formatRewardXp(next.min_xp - xp)} XP to {next.title}
        </span>
      </p>
      <div className="mt-5">
        <RewardsEyebrow>This week</RewardsEyebrow>
      </div>
      <ol className="mt-3 space-y-2">
        {MOCK_BOARD.map((row) => (
          <li
            key={row.handle}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ${
              row.you ? "border-white/40 bg-white/[0.08] text-white" : "border-white/10 bg-[#060606] text-[#D4D4D4]"
            }`}
          >
            <span className="w-7 font-semibold text-[#9E9E9E]">#{row.place}</span>
            <span className="font-medium">{row.handle}</span>
            {row.you ? <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#B5B5B5]">You</span> : null}
            <span className="ml-auto font-semibold">{formatRewardXp(row.xp)} XP</span>
          </li>
        ))}
      </ol>
      <figcaption className="mt-3 text-[11px] text-[#8A8A8A]">Example only. Leaderboards show handles, never real names.</figcaption>
    </figure>
  );
}

const PODIUM_STEP = [
  "order-2 h-40 border-white/40 bg-white/[0.08]",
  "order-1 h-32 border-white/20 bg-white/[0.05]",
  "order-3 h-24 border-white/15 bg-white/[0.03]",
];

/** Weekly leaderboard prizes as a three-step podium (#1 in the middle). */
export function PrizePodium({ title = "Weekly leaderboard prizes", prizes = WEEKLY_PRIZES }) {
  return (
    <div>
      <h3 className="font-reference text-xl font-semibold text-white">{title}</h3>
      <ol aria-label={title} className="mt-4 flex items-end gap-2 sm:gap-3">
        {prizes.map((prize, index) => (
          <li
            key={prize.place}
            className={`flex flex-1 flex-col items-center justify-end rounded-t-2xl border border-b-0 px-2 pb-4 text-center ${PODIUM_STEP[index] || PODIUM_STEP[2]}`}
          >
            <span className="font-reference text-2xl font-semibold text-white">{prize.place}</span>
            <span className="mt-1 text-sm font-semibold text-[#E0E0E0]">{prize.xp}</span>
            <span className="mt-1 text-[11px] uppercase tracking-[0.12em] text-[#9E9E9E]">{prize.label}</span>
          </li>
        ))}
      </ol>
      <div aria-hidden="true" className="h-px bg-white/25" />
    </div>
  );
}

/** "Lead. text" rows with a small white tick. */
export function RewardPoints({ items }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.lead} className="flex gap-3 text-sm leading-6 text-[#A7A7A7]">
          <svg viewBox="0 0 20 20" aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 fill-none stroke-white">
            <path d="M4 10.5l4 4 8-9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>
            <span className="font-semibold text-white">{item.lead}</span> {item.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
