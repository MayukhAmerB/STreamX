// Dev-only gallery sections for the Console rank header (/__insignia?section=
// console-header | console-header-panel | console-header-level-panel |
// console-header-recruit | console-chip | landing-lvl | lvl-badges).
// The real components with fixture data (no network). OWNER: WS-LEARN.
import { MemoryRouter } from "react-router-dom";

import { RankChipView } from "../../app-shell/RankChip";
import { RankHeader } from "../../console-home/RankHeader";
import { buildConsoleRankView } from "../../console-home/rankHeaderModel";
import { LEVELS } from "../../engagement-ui/engagementModel";
import { CompactCard, FullCard } from "../LandingRewardsCard";
import { buildRewardsView } from "../landingRewardsModel";
import LevelBadge from "../LevelBadge";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const BADGES = [
  { key: "streak_7", title: "Week Warrior", tier: "silver", earned_at: "2026-11-14T10:00:00+00:00" },
  { key: "sharp_analyst", title: "Sharp Analyst", tier: "gold", earned_at: "2026-11-09T10:00:00+00:00" },
  { key: "first_report", title: "First Report", tier: "bronze", earned_at: "2026-10-20T10:00:00+00:00" },
  { key: "live_regular", title: "Live Regular", tier: "silver", earned_at: "2026-10-12T10:00:00+00:00" },
  { key: "first_lecture", title: "First Lecture", tier: "bronze", earned_at: "2026-10-02T10:00:00+00:00" },
];
const BATCH = { id: 1, title: "OSINT Foundations", batch: "Batch III" };
const CERTIFICATE = { reference: "ASI-2026-OSINT-000042-7", title: "Certified OSINT Investigator", issued_at: "2026-09-01T00:00:00Z", valid: true };

export const FIXTURES = {
  analyst: {
    me: {
      xp: 6820,
      weekly_xp: 320,
      level: LEVELS[3],
      next_level: LEVELS[4],
      level_progress: 0.273,
      level_up: { pending: false },
      badges: BADGES,
      recent_achievements: [{ kind: "level", key: "analyst", earned_at: "2026-11-02T12:30:00+00:00" }],
    },
    board: { participants: 24, batch: BATCH, me: { rank: 3, xp: 320, handle: "geo_hound" } },
    history: { certificates: [] },
    user: { id: 7, handle: "geo_hound" },
  },
  elite: {
    me: {
      xp: 21450,
      weekly_xp: 1180,
      level: LEVELS[7],
      next_level: null,
      level_progress: 1,
      level_up: { pending: false },
      badges: [
        { key: "streak_100", title: "Centurion", tier: "platinum", earned_at: "2026-11-15T10:00:00+00:00" },
        { key: "batch_top_3", title: "Batch Top 3", tier: "platinum", earned_at: "2026-11-11T10:00:00+00:00" },
        { key: "exam_ace", title: "Exam Ace", tier: "gold", earned_at: "2026-11-01T10:00:00+00:00" },
        ...BADGES,
      ],
      recent_achievements: [{ kind: "level", key: "elite_operator", earned_at: "2026-11-12T08:00:00+00:00" }],
    },
    board: { participants: 24, batch: BATCH, me: { rank: 1, xp: 1180, handle: "quiet_cipher" } },
    history: { certificates: [CERTIFICATE] },
    user: { id: 8, handle: "quiet_cipher" },
  },
  recruit: {
    me: { xp: 40, weekly_xp: 40, level: LEVELS[0], next_level: LEVELS[1], level_progress: 0.03, level_up: { pending: false }, badges: [], recent_achievements: [] },
    board: { participants: 0, batch: null, me: { rank: null, xp: 40, handle: "first_steps" } },
    history: { certificates: [] },
    user: { id: 9, handle: "first_steps" },
  },
};

export const fixtureView = (key) => buildConsoleRankView(FIXTURES[key], { now: NOW });

function Page({ children }) {
  // The Console page frame: black, the Home column (max 75rem) and its gutters.
  return <div className="mx-auto grid w-full max-w-[75rem] gap-8 px-4 sm:px-8">{children}</div>;
}

const label = "text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8a8a8a]";

function Section({ id, title, show, children }) {
  if (show && show !== id) return null;
  return (
    <section id={id} data-section={id} className="border-t border-white/10 py-10">
      <h2 className="mb-6 px-4 text-lg font-semibold text-white sm:px-8">{title}</h2>
      {children}
    </section>
  );
}

/** A Console header strip (48 px) with the compact chip, and the open account menu. */
function ChipHarness({ view }) {
  return (
    <div className="grid gap-6">
      <div className="flex h-12 items-center justify-between border-b border-white/10 bg-black pl-4">
        <span className="text-sm font-semibold text-white">Al Syed Initiative</span>
        <div className="flex h-full items-center">
          {/* Desktop only, as in ShellHeader (the phone header has no room: the chip lives in the account menu there). */}
          <span className="hidden lg:inline-flex">
            <RankChipView level={view.rank} variant="header" />
          </span>
          <span className="mr-2 hidden h-8 w-44 items-center border-b border-[#6f6f6f] bg-[#161616] px-3 text-sm text-[#a1a1a1] lg:inline-flex">Jump to…</span>
          <span className="inline-flex h-12 w-12 items-center justify-center text-[#d4d4d4]" aria-hidden="true">
            ◔
          </span>
          <span className="inline-flex h-12 w-12 items-center justify-center" aria-hidden="true">
            <span className="h-8 w-8 rounded-full bg-[#393939]" />
          </span>
        </div>
      </div>
      <div className="ml-auto w-full max-w-[18rem] border border-white/10 bg-[#161616] pb-2 sm:mr-2">
        <div className="flex items-center gap-4 p-4">
          <span className="h-10 w-10 rounded-full bg-[#393939]" />
          <span className="text-sm text-white">Your account</span>
        </div>
        <RankChipView level={view.rank} variant="menu" />
        <p className="border-t border-white/10 px-4 pt-3 text-sm text-[#a1a1a1]">Profile · ID card · Reduce motion</p>
      </div>
    </div>
  );
}

export default function ConsoleHeaderGallery({ section }) {
  const analyst = fixtureView("analyst");
  const elite = fixtureView("elite");
  const recruit = fixtureView("recruit");
  const landing = buildRewardsView({ ...FIXTURES.analyst, history: { certificates: [CERTIFICATE] } }, { now: NOW });
  return (
    <MemoryRouter>
      <Section id="console-header" title="Console rank header: rank IV and rank VIII" show={section}>
        <Page>
          <RankHeader view={analyst} />
          <RankHeader view={elite} />
        </Page>
      </Section>
      <Section id="console-header-recruit" title="Console rank header: Recruit (no badges, no batch place)" show={section}>
        <Page>
          <RankHeader view={recruit} />
        </Page>
      </Section>
      {section === "console-header-panel" ? (
        <Section id="console-header-panel" title="Rank details panel (rank IV)" show={section}>
          <Page>
            <RankHeader view={analyst} initialPanel="rank" />
          </Page>
        </Section>
      ) : null}
      {section === "console-header-level-panel" ? (
        <Section id="console-header-level-panel" title="Level details panel (rank VIII)" show={section}>
          <Page>
            <RankHeader view={elite} initialPanel="level" />
          </Page>
        </Section>
      ) : null}
      <Section id="console-chip" title="Compact rank chip: Console header (desktop) and account menu" show={section}>
        <div className="grid gap-10">
          <ChipHarness view={analyst} />
          <ChipHarness view={elite} />
        </div>
      </Section>
      <Section id="landing-lvl" title="Landing “Your progress” with the LVL badge" show={section}>
        <Page>
          <CompactCard view={landing} />
          <FullCard view={landing} />
        </Page>
      </Section>
      <Section id="lvl-badges" title="LVL badges at 148, 104, 48 and 24 px" show={section}>
        <div className="grid gap-8 px-4 sm:px-8">
          {[148, 104, 48, 24].map((size) => (
            <div key={size}>
              <p className={`${label} mb-3`}>{size} px</p>
              <ul className="flex flex-wrap items-end gap-4">
                {LEVELS.map((level) => (
                  <li key={level.key}>
                    <LevelBadge number={level.number} title={level.title} size={size} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>
    </MemoryRouter>
  );
}
