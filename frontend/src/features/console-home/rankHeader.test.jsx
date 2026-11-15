// Console rank header (owner item 5): the medal pair at the top of /console,
// the rank / level details panel, the shared data (no duplicate requests),
// the compact chip, and the LVL badge on the landing "Your progress" card.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ auth: { isAuthenticated: false, user: null } }));

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => state.auth }));
vi.mock("../engagement-ui/useEngagement", () => ({ default: () => ({ enabled: false, status: "off" }), useEngagementEnabled: () => true }));
vi.mock("../engagement-ui/engagementApi", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEngagementMe: vi.fn(),
  fetchLeaderboard: vi.fn(),
  fetchMyAchievements: vi.fn(),
}));
vi.mock("../rewards/rewardsApi", async (importOriginal) => ({ ...(await importOriginal()), fetchRewardHistory: vi.fn() }));
vi.mock("../profiles/profilesApi", () => ({ fetchMyProfile: vi.fn() }));
// Radix portals need a DOM: a pass-through that keeps the contract the panel
// relies on (Esc / Close call onOpenChange(false); on close Radix calls
// onCloseAutoFocus, which the panel uses to focus the badge again).
vi.mock("../../kit/Dialog", async () => {
  const React = await import("react");
  const OpenChange = React.createContext(() => {});
  const Dialog = ({ open, onOpenChange, children }) => (open ? <OpenChange.Provider value={onOpenChange}>{children}</OpenChange.Provider> : null);
  // eslint-disable-next-line no-unused-vars
  function DialogContent({ children, onCloseAutoFocus, hideClose, overlayClassName, ...props }) {
    const onOpenChange = React.useContext(OpenChange);
    const closeFocus = React.useRef(onCloseAutoFocus);
    closeFocus.current = onCloseAutoFocus;
    React.useEffect(() => () => closeFocus.current?.({ preventDefault() {}, defaultPrevented: false }), []);
    return (
      <div
        role="dialog"
        {...props}
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
        }}
      >
        {children}
      </div>
    );
  }
  function DialogClose({ children, ...props }) {
    const onOpenChange = React.useContext(OpenChange);
    return (
      <button type="button" {...props} onClick={() => onOpenChange(false)}>
        {children}
      </button>
    );
  }
  return {
    Dialog,
    DialogContent,
    DialogClose,
    DialogTitle: ({ children, ...props }) => <h2 {...props}>{children}</h2>,
    DialogDescription: ({ children, ...props }) => <p {...props}>{children}</p>,
  };
});

import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import { RankChipView } from "../app-shell/RankChip";
import RankChip from "../app-shell/RankChip";
import { fetchEngagementMe, fetchLeaderboard, fetchMyAchievements } from "../engagement-ui/engagementApi";
import { LEVELS } from "../engagement-ui/engagementModel";
import LandingRewardsCard, { CompactCard, FullCard } from "../landing-rewards/LandingRewardsCard";
import { buildRewardsView } from "../landing-rewards/landingRewardsModel";
import LevelBadge, { levelBadgeDetail } from "../landing-rewards/LevelBadge";
import { resetLandingRewardsCache } from "../landing-rewards/useLandingRewards";
import { fetchRewardHistory } from "../rewards/rewardsApi";
import ConsoleRankHeader, { RankHeader } from "./RankHeader";
import HomeView from "./HomeView";
import { batchName, buildConsoleRankView, earnedLabel, levelEarnedAt, mergeMe, positionLabel } from "./rankHeaderModel";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const STUDENT = { id: 7, full_name: "Asha Rao", email: "asha.rao@example.com", role: "student", handle: "geo_hound" };
const BADGES = [
  { key: "first_lecture", title: "First Lecture", tier: "bronze", earned_at: "2026-10-02T10:00:00+00:00" },
  { key: "streak_7", title: "Week Warrior", tier: "silver", earned_at: "2026-11-14T10:00:00+00:00" },
  { key: "first_report", title: "First Report", tier: "bronze", earned_at: "2026-10-20T10:00:00+00:00" },
  { key: "sharp_analyst", title: "Sharp Analyst", tier: "gold", earned_at: "2026-11-09T10:00:00+00:00" },
];
const ME = {
  xp: 6820,
  weekly_xp: 320,
  level: LEVELS[3],
  next_level: LEVELS[4],
  level_progress: 0.273,
  level_up: { pending: false },
  badges: BADGES,
  recent_achievements: [{ kind: "level", key: "analyst", earned_at: "2026-11-02T12:30:00+00:00" }],
};
const BOARD = { participants: 24, batch: { id: 1, title: "OSINT Foundations", batch: "III" }, me: { rank: 3, xp: 320, handle: "geo_hound" } };
const HISTORY = {
  summary: { total_xp: 6820, level: 4, badges_count: 4 },
  badges: [],
  certificates: [{ reference: "ASI-2026-OSINT-000042-7", title: "Certified OSINT Investigator", issued_at: "2026-09-01T00:00:00Z", valid: true }],
};

const view = (overrides = {}) => buildConsoleRankView({ me: ME, board: BOARD, history: HISTORY, user: STUDENT, ...overrides }, { now: NOW });
const html = (node) => renderToStaticMarkup(<StaticRouter location="/console">{node}</StaticRouter>);
const flush = async () => {
  for (let index = 0; index < 5; index += 1) await act(async () => {});
};

async function mount(node) {
  const tree = await renderTree(<MemoryRouter initialEntries={["/console"]}>{node}</MemoryRouter>);
  await flush();
  return tree;
}

beforeEach(() => {
  resetLandingRewardsCache();
  vi.mocked(fetchEngagementMe).mockReset().mockResolvedValue({ status: 200, etag: "", data: ME });
  vi.mocked(fetchLeaderboard).mockReset().mockResolvedValue({ status: 200, etag: "", data: BOARD });
  vi.mocked(fetchRewardHistory).mockReset().mockResolvedValue(HISTORY);
  vi.mocked(fetchMyAchievements).mockReset().mockResolvedValue({
    status: 200,
    etag: "",
    data: { achievements: [{ kind: "level", key: "analyst", earned_at: "2026-10-30T08:00:00+00:00" }] },
  });
  state.auth = { isAuthenticated: true, user: STUDENT };
});

describe("rankHeaderModel", () => {
  it("derives LVL from the rank number and words the meter, position and dates", () => {
    const result = view();
    expect(result.level).toBe(4);
    expect(result.roman).toBe("IV");
    expect(result.handle).toBe("@geo_hound");
    expect(result.xpLine).toBe("6,820 / 9,000 XP");
    expect(result.toNext).toBe("2,180 XP to Specialist");
    expect(result.meter.filled).toBe(2);
    expect(result.position).toBe("#3 in Batch III");
    expect(result.latestBadges.map((badge) => badge.key)).toEqual(["streak_7", "sharp_analyst", "first_report"]);
    expect(result.badges).toHaveLength(4);
    expect(result.certified).toBe(true);
    expect(result.earned).toBe("Earned 2 Nov 2026");
    expect(result.ladder.find((item) => item.state === "current").key).toBe("analyst");
  });

  it("handles the top rank, Recruit, unknown places and optimistic XP", () => {
    const top = view({ me: { ...ME, xp: 21000, level: LEVELS[7], next_level: null }, board: null, history: null });
    expect(top.toNext).toBe("Top rank");
    expect(top.xpLine).toBe("21,000 XP");
    expect(top.position).toBe("");
    expect(top.certified).toBe(false);
    expect(earnedLabel(LEVELS[0], "")).toBe("Starting rank");
    expect(earnedLabel(LEVELS[3], "")).toBe("");
    expect(positionLabel(null, BOARD.batch)).toBe("");
    expect(batchName({ title: "OSINT Foundations", batch: "Batch 7" })).toBe("Batch 7");
    expect(batchName({ title: "OSINT Foundations", batch: "" })).toBe("OSINT Foundations");
    expect(levelEarnedAt(LEVELS[3], [{ kind: "badge", key: "analyst" }], [{ kind: "level", key: "analyst", earned_at: "x" }])).toBe("x");
    const merged = mergeMe(ME, { pending: true, xp: 9050, level: LEVELS[4] });
    expect(merged.level.key).toBe("specialist");
    expect(view({ me: merged }).next.key).toBe("senior_analyst");
  });
});

describe("RankHeader", () => {
  it("renders the medal pair, rank, handle, meter, week XP, position, latest badges and Certified", () => {
    const markup = html(<RankHeader view={view()} />);
    expect(markup).toContain('data-testid="console-rank-header"');
    expect(markup).toMatch(/<svg class="lr-emblem lr-emblem--r4[^"]*"[^>]*width="184"/);
    expect(markup).toMatch(/<svg class="lv-badge lv-badge--l4[^"]*"[^>]*width="112"/);
    expect(markup).toContain('aria-label="Rank IV, Analyst: open rank details"');
    expect(markup).toContain('aria-label="Level 4: open level details"');
    expect(markup).toContain("Analyst");
    expect(markup).toContain("Your rank · Rank IV of 8");
    expect(markup).toContain("LVL 4");
    expect(markup).toContain("@geo_hound");
    expect(markup).toContain('class="lr-meter"');
    expect(markup).toContain("6,820 / 9,000 XP");
    expect(markup).toContain("2,180 XP to Specialist");
    expect(markup).toContain("+320 XP");
    expect(markup).toContain("#3 in Batch III");
    expect((markup.match(/class="rh__badge"/g) || []).length).toBe(3);
    expect(markup).toContain("Certified");
    expect(markup).toContain('href="/achievements"');
    expect(markup).not.toContain("Asha");
    expect(markup).not.toContain("asha.rao@example.com");
  });

  it("is the very first thing on the Console home", () => {
    const markup = html(<HomeView user={STUDENT} data={null} rankHeader={<RankHeader view={view()} />} />);
    expect(markup.indexOf("console-rank-header")).toBeLessThan(markup.indexOf("ch-greeting"));
    expect(markup.indexOf("console-rank-header")).toBeGreaterThan(-1);
  });

  it("opens the details panel from the rank emblem; Esc closes it and focus returns to the emblem", async () => {
    const tree = await mount(<RankHeader view={view()} />);
    expect(tree.find((node) => node.props?.role === "dialog")).toBeNull();
    const rankButton = tree.getByLabel("button", "open rank details");
    await fire(rankButton, "onClick");

    const dialog = tree.find((node) => node.props?.role === "dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["data-kind"]).toBe("rank");
    const text = textOf(dialog);
    expect(text).toContain("Analyst");
    expect(text).toContain("Earned 2 Nov 2026");
    expect(text).toContain("6,820");
    expect(text).toContain("2,180 XP to Specialist");
    // How to earn XP, with the report-mark bonus on top of 30 XP / 40 XP on time.
    expect(text).toContain("30 XP");
    expect(text).toContain("40 XP when it is on time");
    expect(text).toContain("10/10+300 XP");
    expect(text).toContain("6/10+40 XP");
    // The ladder: eight ranks, the current one highlighted.
    const ranks = tree.all((node) => node.type === "li" && String(node.props.className || "").startsWith("rh-ladder__rank"));
    expect(ranks).toHaveLength(8);
    const current = ranks.filter((node) => node.props["aria-current"] === "step");
    expect(current).toHaveLength(1);
    expect(current[0].props["data-rank"]).toBe(4);
    expect(textOf(current[0])).toContain("You are here");
    // Earned badges with dates.
    expect(text).toContain("Week Warrior");
    expect(text).toContain("Earned 14 Nov 2026");
    expect(fetchMyAchievements).not.toHaveBeenCalled();

    await fire(dialog, "onKeyDown", { key: "Escape" });
    expect(tree.find((node) => node.props?.role === "dialog")).toBeNull();
    expect(rankButton.focused).toBe(true);
  });

  it("opens the level view from the LVL badge and closes with the close button", async () => {
    const tree = await mount(<RankHeader view={view()} />);
    const levelButton = tree.getByLabel("button", "open level details");
    await fire(levelButton, "onClick");
    const dialog = tree.find((node) => node.props?.role === "dialog");
    expect(dialog.props["data-kind"]).toBe("level");
    expect(textOf(dialog)).toContain("Level 4");
    expect(textOf(dialog)).toContain("LVL 4 is rank IV of 8");
    await fire(tree.getByLabel("button", "Close details"), "onClick");
    expect(tree.find((node) => node.props?.role === "dialog")).toBeNull();
    expect(levelButton.focused).toBe(true);
  });

  it("reads the level date from the achievements list only when /me lacks it, and only once opened", async () => {
    const tree = await mount(<RankHeader view={view({ me: { ...ME, recent_achievements: [] } })} />);
    expect(fetchMyAchievements).not.toHaveBeenCalled();
    await fire(tree.getByLabel("button", "open rank details"), "onClick");
    await flush();
    expect(fetchMyAchievements).toHaveBeenCalledTimes(1);
    expect(textOf(tree.find((node) => node.props?.role === "dialog"))).toContain("Earned 30 Oct 2026");
  });
});

describe("ConsoleRankHeader data", () => {
  const engagement = { enabled: true, status: "ready", data: ME, summary: { xp: ME.xp, level: ME.level, pending: false } };

  it("reuses the engagement store for /me and shares one board + history round with the landing card", async () => {
    const tree = await mount(
      <>
        <ConsoleRankHeader engagement={engagement} />
        <ConsoleRankHeader engagement={engagement} />
        <LandingRewardsCard variant="compact" />
      </>
    );
    expect(tree.all((node) => node.props?.["data-testid"] === "console-rank-header")).toHaveLength(2);
    expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
    expect(fetchRewardHistory).toHaveBeenCalledTimes(1);
    // Only the landing card reads /me itself; the header uses the store's payload.
    expect(fetchEngagementMe).toHaveBeenCalledTimes(1);
    expect(tree.text()).toContain("#3 in Batch III");
  });

  it("renders nothing for staff or a switched-off engagement, and a quiet skeleton while loading", async () => {
    const staff = { ...STUDENT, role: "instructor" };
    state.auth = { isAuthenticated: true, user: staff, isInstructor: true };
    expect(html(<ConsoleRankHeader engagement={engagement} />)).toBe("");
    state.auth = { isAuthenticated: true, user: STUDENT };
    expect(html(<ConsoleRankHeader engagement={{ enabled: false, status: "off", data: null }} />)).toBe("");
    expect(html(<ConsoleRankHeader engagement={{ enabled: true, status: "disabled", data: null }} />)).toBe("");
    expect(html(<ConsoleRankHeader engagement={{ enabled: true, status: "error", data: null }} />)).toBe("");
    expect(html(<ConsoleRankHeader engagement={{ enabled: true, status: "loading", data: null }} />)).toContain("console-rank-header-skeleton");
    expect(fetchLeaderboard).not.toHaveBeenCalled();
  });
});

describe("LevelBadge", () => {
  it("draws LVL and the number with an accessible name", () => {
    const markup = renderToStaticMarkup(<LevelBadge number={5} title="Specialist" size={104} />);
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Level 5 of 8, Specialist"');
    expect(markup).toContain(">LVL<");
    expect(markup).toContain(">5<");
    expect(markup).toContain('data-detail="standard"');
    expect(renderToStaticMarkup(<LevelBadge number={12} size={160} />)).toContain('data-level="8"');
  });

  it("turns into a one-line tag at 24 px so LVL and the number stay legible", () => {
    const markup = renderToStaticMarkup(<LevelBadge number={3} size={24} />);
    expect(markup).toContain('data-detail="compact"');
    expect(markup).toContain('height="24"');
    expect(markup).toContain('width="58"');
    expect(markup).toContain(">LVL<");
    expect(markup).toContain(">3<");
    expect(levelBadgeDetail("auto", 40)).toBe("compact");
    expect(levelBadgeDetail("auto", 120)).toBe("full");
    expect(renderToStaticMarkup(<LevelBadge number={3} size={24} decorative />)).toContain('aria-hidden="true"');
  });

  it("gives every badge its own gradient ids", () => {
    const markup = renderToStaticMarkup(
      <>
        <LevelBadge number={2} size={48} />
        <LevelBadge number={2} size={48} />
      </>
    );
    const ids = [...markup.matchAll(/id="([^"]+-rim)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("compact rank chip", () => {
  it("shows a 24 px emblem, the LVL tag and the rank title, linking to /achievements", () => {
    const markup = html(<RankChipView level={LEVELS[3]} />);
    expect(markup).toContain('href="/achievements"');
    expect(markup).toContain('aria-label="Rank IV, Analyst, level 4: view achievements"');
    expect(markup).toMatch(/lr-emblem--r4[^"]*"[^>]*width="24"/);
    expect(markup).toContain('data-detail="compact"');
    expect(markup).toContain("Analyst");
  });

  it("renders nothing without a student's engagement data", () => {
    expect(html(<RankChip />)).toBe("");
  });
});

describe("landing card LVL badge", () => {
  it("pairs the LVL badge with the rank emblem on both cards", () => {
    const landing = buildRewardsView({ me: { ...ME, level: LEVELS[2], next_level: LEVELS[3], xp: 4870 }, board: BOARD, history: HISTORY }, { now: NOW });
    const compact = html(<CompactCard view={landing} />);
    expect(compact).toContain('data-testid="landing-medal-pair"');
    expect(compact).toContain('aria-label="Level 3 of 8, Operator"');
    expect(compact).toContain("LVL 3");
    const full = html(<FullCard view={landing} />);
    expect(full).toMatch(/lv-badge--l3[^"]*"[^>]*width="64"/);
    expect(full).toContain("Rank III of 8 · LVL 3");
  });
});
