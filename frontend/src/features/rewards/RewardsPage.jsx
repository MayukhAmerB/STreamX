// Public /rewards: the full reward system in the Friday website style
// (black canvas, hairline panels, greys and white; no gold). How XP is
// earned, the eight ranks, the badge catalogue, weekly leaderboard prizes,
// the Monthly CTF reward, certificates (explained only: nobody else's
// certificate is ever shown) and a link to the Hall of Fame.
import { Link } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import {
  BADGE_GROUPS,
  CERTIFICATES_INFO,
  MONTHLY_CTF,
  RANKS_NOTE,
  REWARDS_INTRO,
  TIER_LABELS,
} from "./rewardsContent";
import { PrizePodium, RankLadder, ReportBonusTiers, RewardPoints, RewardsEyebrow, RewardsMock, XpWays } from "./RewardsVisuals";

const TIER_PIPS = { bronze: 1, silver: 2, gold: 3, platinum: 4 };

const linkPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black";
const linkSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-5 text-sm font-semibold text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

function Panel({ id, title, subtitle, children }) {
  return (
    <section
      aria-labelledby={id}
      className="relative overflow-hidden rounded-[22px] border border-white/10 bg-[#070707] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-7"
    >
      <div className="max-w-3xl">
        <div className="mb-4 flex items-center gap-3" aria-hidden="true">
          <span className="h-px w-10 bg-white/70" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8E8E8E]">Rewards</span>
        </div>
        <h2 id={id} className="font-reference text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </h2>
        {subtitle ? <p className="mt-3 max-w-2xl text-sm leading-7 text-[#A7A7A7]">{subtitle}</p> : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function TierPips({ tier }) {
  const count = TIER_PIPS[tier] || 0;
  return (
    <span className="flex gap-1" aria-hidden="true">
      {[1, 2, 3, 4].map((pip) => (
        <span key={pip} className={`h-1.5 w-1.5 rounded-full ${pip <= count ? "bg-white" : "bg-white/15"}`} />
      ))}
    </span>
  );
}

export function BadgeCatalogue({ groups = BADGE_GROUPS }) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <div key={group.key}>
          <h3 className="font-reference text-lg font-semibold text-white">{group.title}</h3>
          <ul className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
            {group.badges.map((badge) => (
              <li key={badge.key} className="flex flex-col rounded-2xl border border-white/10 bg-[#0A0A0A] p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#B5B5B5]">
                    {TIER_LABELS[badge.tier] || badge.tier}
                  </span>
                  <TierPips tier={badge.tier} />
                </div>
                <span className="mt-3 text-sm font-semibold text-white">{badge.title}</span>
                <span className="mt-1 text-xs leading-5 text-[#999999]">{badge.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function RewardsPage() {
  const { isAuthenticated } = useAuth();
  return (
    <div className="relative bg-[#030303] text-[#F6F6F6]">
      <section className="border-b border-white/10 bg-black px-4">
        <div className="mx-auto max-w-6xl py-12 sm:py-16">
          <p className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.24em] text-[#B8B8B8] sm:text-xs">
            <span className="h-px w-10 bg-white/65" aria-hidden="true" />
            Reward system
          </p>
          <h1 className="mt-5 font-reference text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            {REWARDS_INTRO.title}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#A7A7A7]">{REWARDS_INTRO.subtitle}</p>
          <div className="mt-7 flex flex-wrap gap-2">
            <Link to={isAuthenticated ? "/profile" : "/courses"} className={linkPrimary}>
              {isAuthenticated ? "See my rewards" : "Browse courses"}
            </Link>
            <Link to="/hall-of-fame" className={linkSecondary}>
              Hall of Fame
            </Link>
          </div>
        </div>
      </section>

      <div className="px-4 pb-20 pt-8">
        <div className="mx-auto max-w-6xl space-y-8">
          <Panel id="rewards-xp" title="How XP is earned" subtitle="XP is added automatically: you never claim it.">
            <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
              <XpWays title="Ways to earn" />
              <RewardsMock />
            </div>
            <ReportBonusTiers className="mt-6" />
          </Panel>

          <Panel id="rewards-ranks" title="Ranks" subtitle={RANKS_NOTE}>
            <RankLadder title="Eight ranks" />
          </Panel>

          <Panel id="rewards-badges" title="Badges" subtitle="Earned for steady habits, reports, exams and live classes. A badge's tier is a word and a number of dots.">
            <BadgeCatalogue />
          </Panel>

          <Panel id="rewards-weekly" title="Weekly leaderboard" subtitle="Each week your batch leaderboard turns XP into prize XP. It shows handles only, never real names, and you can hide yourself from it.">
            <div className="max-w-xl">
              <PrizePodium />
            </div>
          </Panel>

          <div className="grid gap-8 lg:grid-cols-2">
            <Panel id="rewards-ctf" title={MONTHLY_CTF.title} subtitle={MONTHLY_CTF.body}>
              <RewardPoints items={MONTHLY_CTF.rewards} />
              <div className="mt-5">
                <Link to="/monthly-ctf" className={linkSecondary}>
                  Monthly CTF
                </Link>
              </div>
            </Panel>

            <Panel id="rewards-certificates" title={CERTIFICATES_INFO.title} subtitle={CERTIFICATES_INFO.body}>
              <RewardPoints items={CERTIFICATES_INFO.points} />
            </Panel>
          </div>

          <section
            aria-labelledby="rewards-hall"
            className="rounded-2xl border border-white/10 bg-[#090909] p-5 sm:p-6"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <RewardsEyebrow>Hall of Fame</RewardsEyebrow>
                <h2 id="rewards-hall" className="mt-2 font-reference text-2xl font-semibold text-white">
                  Every certified graduate, batch by batch
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#A8A8A8]">
                  Graduates appear under the handle they chose. Never a real name.
                </p>
              </div>
              <Link to="/hall-of-fame" className={linkPrimary}>
                Open the Hall of Fame
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
