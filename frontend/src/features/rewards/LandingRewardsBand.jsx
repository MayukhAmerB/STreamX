// The reward-system band at the very end of the Friday landing page (just
// before the footer). Same panel as the landing's SectionCard/SectionTitle
// (black panel, hairline border, brand eyebrow rule); greys and white only.
import { Link } from "react-router-dom";

import { siteBrand } from "../../config/siteBrand";
import { RANKS_NOTE, RECORD_POINTS, REWARDS_INTRO } from "./rewardsContent";
import { PrizePodium, RankLadder, RewardPoints, RewardsMock, XpWays } from "./RewardsVisuals";

const linkPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black";
const linkSecondary =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-5 text-sm font-semibold text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

export default function LandingRewardsBand() {
  return (
    <section
      id="rewards"
      aria-labelledby="landing-rewards-title"
      className="relative mx-auto max-w-6xl overflow-hidden rounded-[22px] border border-white/10 bg-[#070707] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-7"
    >
      <div className="relative z-10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-4 flex items-center gap-3" aria-hidden="true">
              <span className="h-px w-10 bg-white/70" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8E8E8E]">{siteBrand.name}</span>
            </div>
            <h2 id="landing-rewards-title" className="font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              {REWARDS_INTRO.title}
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[#A7A7A7] sm:text-base">{REWARDS_INTRO.subtitle}</p>
          </div>
          <Link to="/rewards" className={`${linkPrimary} self-start lg:self-auto`}>
            See all rewards
          </Link>
        </div>

        <div className="mt-8">
          <RankLadder note={RANKS_NOTE} />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
          <XpWays />
          <RewardsMock />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <PrizePodium />
          <div className="rounded-2xl border border-white/10 bg-[#090909] p-5">
            <h3 className="font-reference text-xl font-semibold text-white">Also on your record</h3>
            <div className="mt-4">
              <RewardPoints items={RECORD_POINTS} />
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link to="/hall-of-fame" className={linkSecondary}>
                Hall of Fame
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
