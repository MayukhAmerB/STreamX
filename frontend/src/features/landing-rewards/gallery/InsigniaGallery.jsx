// Insignia gallery (dev only, /__insignia). OWNER: WS-LEARN.
// Every rank emblem at 24 / 64 / 200 px and every badge medal (each catalogue
// key at its tier, every glyph in every tier, earned and locked) on the site's
// black canvas, for screenshots at 390 and 1440. Not a build input.
import { MemoryRouter } from "react-router-dom";

import { LevelCard, RanksPanel } from "../../engagement-ui/AchievementsPage";
import { BadgeMedal } from "../../engagement-ui/EngagementParts";
import { LEVELS, badgeGlyph, tierInfo } from "../../engagement-ui/engagementModel";
import { Board } from "../../engagement-ui/LeaderboardPage";
import { RankProgress } from "../../rewards/RewardRecord";
import { RankLadder } from "../../rewards/RewardsVisuals";
import RankEmblem from "../RankEmblem";
import { romanRank } from "../landingRewardsModel";
import ConsoleHeaderGallery from "./ConsoleHeaderGallery";
import LevelUpGallery from "./LevelUpGallery";

// backend/apps/engagement/badges.py: CATALOGUE, PODIUM_WEEK, the legacy badges and one Batch Pioneer.
export const BADGE_CATALOGUE = [
  ["first_lecture", "First Lecture", "bronze"],
  ["lecture_10", "Ten Down", "silver"],
  ["lecture_50", "Half Century", "gold"],
  ["course_finisher", "Course Finisher", "gold"],
  ["deep_focus", "Deep Focus", "silver"],
  ["night_owl", "Night Owl", "bronze"],
  ["early_bird", "Early Bird", "bronze"],
  ["streak_3", "On a Roll", "bronze"],
  ["streak_7", "Week Warrior", "silver"],
  ["streak_30", "Unbreakable", "gold"],
  ["streak_100", "Centurion", "platinum"],
  ["weekend_warrior", "Weekend Warrior", "bronze"],
  ["comeback", "Comeback", "bronze"],
  ["first_report", "First Report", "bronze"],
  ["report_ranger", "Report Ranger", "silver"],
  ["punctual", "Punctual", "silver"],
  ["sharp_analyst", "Sharp Analyst", "gold"],
  ["perfect_score", "Perfect Score", "gold"],
  ["first_exam", "First Exam", "bronze"],
  ["exam_ace", "Exam Ace", "gold"],
  ["batch_top_3", "Batch Top 3", "platinum"],
  ["first_live", "First Live Class", "bronze"],
  ["live_regular", "Live Regular", "silver"],
  ["live_devotee", "Live Devotee", "gold"],
  ["xp_1000", "Thousand Club", "silver"],
  ["xp_5000", "Five Thousand", "gold"],
  ["podium_week", "Podium Week", "gold"],
  ["founding_operative", "Founding Operative", "platinum"],
  ["founding_graduate", "Founding Graduate", "platinum"],
  ["founding_member", "Founding Member", "gold"],
  ["batch_pioneer_3", "Batch Pioneer, Batch 3", "silver"],
];

const TIERS = ["bronze", "silver", "gold", "platinum"];
const GLYPH_KEYS = [...new Map(BADGE_CATALOGUE.map(([key]) => [badgeGlyph(key), key])).values()];

const label = "text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8a8a8a]";

function Block({ id, title, note, children, show }) {
  if (show && show !== id) return null;
  return (
    <section id={id} data-section={id} className="border-t border-white/10 px-4 py-10 sm:px-8">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {note ? <p className="mt-1 max-w-3xl text-sm text-[#a1a1a1]">{note}</p> : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function RankRow({ size, shine = false }) {
  return (
    <ul className="flex flex-wrap items-end gap-x-6 gap-y-8">
      {LEVELS.map((level) => (
        <li key={level.key} className="flex flex-col items-center gap-2 text-center">
          <RankEmblem number={level.number} title={level.title} size={size} shine={shine} />
          <span className={label}>
            {romanRank(level.number)} · {level.title}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function InsigniaGallery({ section }) {
  return (
    <main className="min-h-screen bg-black pb-16 text-[#fafafa]">
      <header className="px-4 pb-6 pt-10 sm:px-8">
        <p className={label}>Dev only · /__insignia</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Rank emblems and badge medals</h1>
        <p className="mt-2 max-w-3xl text-sm text-[#a1a1a1]">
          Eight ranks, Recruit to Elite Operator; badge tiers bronze, silver, gold, platinum (forged as gunmetal, steel, platinum with a
          cyan core, obsidian and platinum with an emerald core). Query: ?section=&lt;id&gt;, ?motion=reduce.
        </p>
      </header>

      <Block id="ranks-200" title="Ranks at 200 px" note="Level-up overlay size: full detail, ribbon with the rank title." show={section}>
        <RankRow size={200} />
      </Block>

      <Block id="ranks-128" title="Ranks at 132 px, celebratory shine" note="Landing card hero size." show={section}>
        <RankRow size={132} shine />
      </Block>

      <Block id="ranks-64" title="Ranks at 64 px" note="Card size: standard detail (no ribbon)." show={section}>
        <RankRow size={64} />
      </Block>

      <Block id="ranks-24" title="Ranks at 24 px" note="Chip size: compact silhouettes with chevrons or a big numeral." show={section}>
        <RankRow size={24} />
        <ul className="mt-8 grid max-w-md gap-2">
          {LEVELS.map((level) => (
            <li key={level.key} className="flex items-center gap-3 rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm">
              <span className="w-6 font-mono text-[#8a8a8a]">{String(level.number).padStart(2, "0")}</span>
              <span className="flex-1 text-white">@learner_{level.number}</span>
              <span className="flex items-center gap-2 text-[#a1a1a1]">
                <RankEmblem number={level.number} title={level.title} size={24} decorative />
                {level.title}
              </span>
            </li>
          ))}
        </ul>
      </Block>

      <Block id="medal-tiers" title="Medal tiers" note="Every glyph in every tier, earned, then locked. 56 px." show={section}>
        <div className="grid gap-6">
          {[true, false].map((earned) => (
            <div key={String(earned)}>
              <p className={label}>{earned ? "Earned" : "Locked"}</p>
              <div className="mt-3 grid gap-3">
                {TIERS.map((tier) => (
                  <div key={tier} className="flex flex-wrap items-center gap-3">
                    <span className={`${label} w-20`}>{tierInfo(tier).label}</span>
                    {GLYPH_KEYS.map((key) => (
                      <BadgeMedal key={key} badgeKey={key} tier={tier} earned={earned} size={56} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Block>

      <Block id="medal-catalogue" title="Badge catalogue" note="Each key at its catalogue tier, earned (72 px) and locked (40 px)." show={section}>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-8">
          {BADGE_CATALOGUE.map(([key, title, tier]) => (
            <li key={key} className="flex flex-col items-center gap-2 text-center">
              <div className="flex items-end gap-2">
                <BadgeMedal badgeKey={key} tier={tier} earned size={72} />
                <BadgeMedal badgeKey={key} tier={tier} size={40} />
              </div>
              <span className="text-xs font-semibold text-white">{title}</span>
              <span className={label}>{tierInfo(tier).label}</span>
            </li>
          ))}
        </ul>
      </Block>

      <Block id="medal-small" title="Medals at 36 and 24 px" note="Journey screen and dense lists." show={section}>
        {[36, 24].map((size) => (
          <div key={size} className="mb-4 flex flex-wrap items-center gap-2">
            {BADGE_CATALOGUE.map(([key, , tier]) => (
              <BadgeMedal key={key} badgeKey={key} tier={tier} earned size={size} />
            ))}
          </div>
        ))}
      </Block>
      <Block id="in-context" title="In context" note="Achievements level card and rank ladder, leaderboard rows, profile rank progress, the rewards rank ladder." show={section}>
        <MemoryRouter>
          <div className="eg-page grid gap-6" data-template="t8">
            <LevelCard data={{ xp: 13250, level: LEVELS[5], next_level: LEVELS[6] }} summary={{ xp: 13250, level: LEVELS[5] }} />
            <RanksPanel xp={13250} levelNumber={6} />
            <Board
              period="week"
              data={{
                batch: { id: 1, title: "OSINT Foundations", batch: "Batch 7" },
                participants: 4,
                entries: [
                  { rank: 1, handle: "quiet_cipher", xp: 1295, level: LEVELS[7], is_me: false },
                  { rank: 2, handle: "you_here", xp: 980, level: LEVELS[5], is_me: true },
                  { rank: 3, handle: "night_trace", xp: 640, level: { title: "Analyst" }, is_me: false },
                  { rank: 4, handle: "first_steps", xp: 40, level: LEVELS[0], is_me: false },
                ],
                me: { rank: 2, xp: 980, visible: true, handle: "you_here" },
              }}
            />
          </div>
          <div className="mt-8 grid max-w-xl gap-6">
            <RankProgress summary={{ total_xp: 4870, level: 3, badges_count: 2, current_streak: 3, best_streak: 9 }} />
          </div>
          <div className="mt-8">
            <RankLadder />
          </div>
        </MemoryRouter>
      </Block>
      <ConsoleHeaderGallery section={section} />
      <LevelUpGallery section={section} />
    </main>
  );
}
