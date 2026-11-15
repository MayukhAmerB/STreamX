// Monthly OSINT CTF UI units. OWNER: WS-MONTHLY-CTF.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../../test-utils/renderTree";

const api = vi.hoisted(() => ({
  fetchCurrentSeason: vi.fn(),
  fetchSeason: vi.fn(),
  fetchSeasonLeaderboard: vi.fn(),
  submitSeasonAnswer: vi.fn(),
  fetchMySeasonSummary: vi.fn(),
  fetchCosmetics: vi.fn(),
  fetchHallOfFame: vi.fn(),
  fetchCertificate: vi.fn(),
  seasonErrorKind: (error) => {
    const status = error?.response?.status;
    const code = error?.response?.data?.code || error?.response?.data?.errors?.code;
    if (status === 403 && code === "feature_disabled") return "off";
    if (status === 404) return "missing";
    return "error";
  },
}));
vi.mock("./seasonApi", () => api);

// Radix Presence needs a real DOM; the in-memory renderer gets plain tabs.
vi.mock("../../kit/Tabs", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const Current = createContext("");
  return {
    Tabs: ({ value, children }) => createElement(Current.Provider, { value }, createElement("div", null, children)),
    TabsList: ({ children, ...rest }) => createElement("div", { role: "tablist", ...rest }, children),
    TabsTrigger: ({ value, children }) => createElement("button", { role: "tab", "data-value": value }, children),
    TabsContent: ({ value, children }) => (useContext(Current) === value ? createElement("div", { role: "tabpanel" }, children) : null),
  };
});

const auth = vi.hoisted(() => ({ value: {} }));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => auth.value }));

import { CosmeticName, CosmeticRing, HandleAvatar, RankMark, TrophyMark, cosmeticWords } from "./Cosmetics";
import MonthlyCtfHallOfFamePage from "./MonthlyCtfHallOfFamePage";
import MonthlyCtfPage from "./MonthlyCtfPage";
import MonthlyCtfPlayPage from "./MonthlyCtfPlayPage";
import { SeasonLeaderboard, RewardGrid, DEFAULT_REWARDS } from "./SeasonParts";
import {
  briefParagraphs,
  certificatePath,
  countdownFor,
  formatDuration,
  formatIst,
  handleInitials,
  monthlyCtfEnabled,
  normaliseCosmetics,
  ordinal,
  playTarget,
  spokenDuration,
} from "./seasonModel";
import useMyCosmetics, { resetCosmeticsCache } from "./useMyCosmetics";

const render = (node, location = "/monthly-ctf") => renderToStaticMarkup(<StaticRouter location={location}>{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

const NOW = Date.parse("2026-11-15T06:00:00Z");
const SEASON = {
  slug: "2026-11",
  title: "The Harbour Photograph",
  tagline: "Find the date a photo was taken.",
  month: "November 2026",
  status: "open",
  phase: "open",
  opens_at: "2026-10-31T18:30:00Z",
  closes_at: "2026-11-30T18:29:00Z",
  difficulty: "medium",
  skills: ["GEOINT", "Chronolocation"],
  solvers: 3,
  participants: 9,
  penalty_seconds: 600,
  max_attempts: 50,
  solve_xp: 100,
  can_play: true,
  play_reason: "",
  content_visible: true,
  brief: "A photo of a harbour.\n\nWork out the date.",
  question: "On what date was it taken?",
  flag_format: "YYYY-MM-DD",
  materials_url: "",
  me: { joined: true, solved: false, attempts: 1, wrong_attempts: 1, attempts_left: 49, rank: null, disqualified: false, solved_at: null, solve_seconds: null, score_seconds: null },
};
const BOARD = {
  season: "2026-11",
  final: false,
  solvers: 3,
  participants: 9,
  penalty_seconds: 600,
  rows: [
    { rank: 1, name: "QuietFalcon42", score_seconds: 5420, wrong_attempts: 0, attempts: 1, first_blood: true, is_me: false, cosmetics: { aura: true, frame: true, frame_tier: "gold", title: "First Blood", until: null } },
    { rank: 2, name: "LunarLedger17", score_seconds: 7210, wrong_attempts: 2, attempts: 3, first_blood: false, is_me: true, cosmetics: { aura: false, frame: false, frame_tier: "", title: "", until: null } },
  ],
  me: null,
};

describe("season model", () => {
  it("links a finalist certificate to the certificate system, not the old Monthly CTF path", () => {
    expect(certificatePath("k3y 9")).toBe("/certificates/k3y%209");
  });

  it("formats durations, ordinals and IST times", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3725)).toBe("1h 2m");
    expect(formatDuration(2 * 86400 + 3 * 3600)).toBe("2d 3h");
    expect(formatDuration(-1)).toBe("—");
    expect(spokenDuration(3725)).toBe("1 hour 2 minutes");
    expect(spokenDuration(1)).toBe("1 second");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "103rd"]);
    expect(formatIst("2026-11-30T18:29:00Z")).toBe("30 Nov, 23:59 IST");
    expect(formatIst("2026-11-30T18:29:00Z", { withTime: false })).toBe("30 Nov 2026");
  });

  it("counts down to close while open and to open while upcoming", () => {
    expect(countdownFor(SEASON, NOW)).toEqual({ label: "Closes in", seconds: Math.floor((Date.parse(SEASON.closes_at) - NOW) / 1000) });
    expect(countdownFor({ ...SEASON, phase: "upcoming", opens_at: "2026-11-15T06:01:00Z" }, NOW)).toEqual({ label: "Opens in", seconds: 60 });
    expect(countdownFor({ ...SEASON, phase: "results" }, NOW)).toBeNull();
  });

  it("splits briefs, builds initials, normalises cosmetics and reads the switch", () => {
    expect(briefParagraphs("a\n\n b \r\n\r\nc")).toEqual(["a", "b", "c"]);
    expect(handleInitials("QuietFalcon42")).toBe("QF");
    expect(handleInitials("Zara Qureshi")).toBe("ZQ");
    expect(handleInitials("")).toBe("?");
    expect(normaliseCosmetics({ aura: 1, frame_tier: "purple" })).toEqual({ aura: true, frame: false, frame_tier: "", title: "", until: null });
    expect(monthlyCtfEnabled({ features: { monthly_ctf: { enabled: true } } })).toBe(true);
    expect(monthlyCtfEnabled({ features: {} })).toBeNull();
    expect(playTarget(false)).toBe("/login?next=%2Fmonthly-ctf%2Fplay");
    expect(playTarget(true)).toBe("/monthly-ctf/play");
  });
});

describe("cosmetics", () => {
  it("wraps the avatar only while a cosmetic is active and names it in words", () => {
    expect(render(<CosmeticRing cosmetics={{}}><span>A</span></CosmeticRing>)).toBe("<span>A</span>");
    const aura = render(<HandleAvatar name="QuietFalcon42" cosmetics={{ aura: true }} animated />);
    expect(aura).toContain("mctf-aura");
    expect(aura).toContain('data-animated="true"');
    const frame = render(<HandleAvatar name="QuietFalcon42" cosmetics={{ frame: true }} animated />);
    expect(frame).toContain("mctf-frame");
    expect(frame).not.toContain("data-animated");
    expect(text(render(<CosmeticName name="QuietFalcon42" cosmetics={{ aura: true, title: "First Blood" }} />))).toContain("QuietFalcon42 (Golden Aura) First Blood");
    expect(cosmeticWords({ aura: true, frame: true, frame_tier: "silver", title: "First Blood" })).toEqual(["Golden Aura", "Silver podium frame", "First Blood"]);
  });

  it("draws trophies by luminance and pattern, never hue", () => {
    const gold = render(<TrophyMark tier="gold" />);
    const silver = render(<TrophyMark tier="silver" />);
    const bronze = render(<TrophyMark tier="bronze" />);
    expect(gold).toContain("#F3E2B3");
    expect(silver).toContain("#bdbdbd");
    expect(bronze).toContain("pattern");
    for (const svg of [gold, silver, bronze]) {
      const colours = svg.match(/#[0-9a-fA-F]{6}/g) || [];
      for (const hex of colours) {
        const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
        const greyish = Math.max(r, g, b) - Math.min(r, g, b) <= 2;
        expect(greyish || hex.toUpperCase() === "#F3E2B3", `${hex} is outside the palette`).toBe(true);
      }
    }
    expect(text(render(<RankMark rank={2} />))).toContain("Rank 2 (Silver)");
  });
});

describe("leaderboard and rewards", () => {
  it("shows handles, first blood, the viewer's row and spoken times", () => {
    const html = render(<SeasonLeaderboard board={BOARD} caption="Board" />);
    const words = text(html);
    expect(words).toContain("QuietFalcon42");
    expect(words).toContain("First Blood");
    expect(words).toContain("You");
    expect(words).toContain("1 hour 30 minutes");
    expect(html).toContain('data-rank="1"');
  });

  it("appends the viewer below the top rows when they are outside it", () => {
    const board = { ...BOARD, rows: [BOARD.rows[0]], me: { ...BOARD.rows[1], rank: 42 } };
    const html = render(<SeasonLeaderboard board={board} />);
    expect(html).toContain('data-rank="42"');
  });

  it("explains an empty board and lists five reward tiers", () => {
    expect(text(render(<SeasonLeaderboard board={{ rows: [] }} />))).toContain("First Blood");
    const grid = text(render(<RewardGrid />));
    for (const reward of DEFAULT_REWARDS) expect(grid).toContain(reward.title);
  });
});

describe("pages", () => {
  let tree;
  beforeEach(() => {
    auth.value = {};
    Object.values(api).forEach((fn) => typeof fn?.mockReset === "function" && fn.mockReset());
    vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout, location: { href: "http://x/" } }));
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, documentElement: { dataset: {} } });
  });
  afterEach(async () => {
    await tree?.unmount?.();
    tree = null;
    vi.unstubAllGlobals();
  });

  const mount = async (node, location) => {
    tree = await renderTree(<StaticRouter location={location}>{node}</StaticRouter>);
    await flush();
    await flush();
    return tree;
  };

  it("public page: disables play with the reason while the switch is off (never hides it)", async () => {
    api.fetchCurrentSeason.mockRejectedValue({ response: { status: 403, data: { code: "feature_disabled" } } });
    const page = await mount(<MonthlyCtfPage />, "/monthly-ctf");
    const words = page.text();
    expect(words).toContain("Play this month's case");
    expect(words).toContain("The Monthly CTF is not open yet");
    const disabled = page.all((node) => node.props?.["aria-disabled"] === "true");
    expect(disabled.length).toBeGreaterThan(0);
  });

  it("public page: visitors are sent to sign in, the board shows the top 10", async () => {
    api.fetchCurrentSeason.mockResolvedValue({ season: { ...SEASON, content_visible: false, brief: null }, rewards: DEFAULT_REWARDS });
    api.fetchSeasonLeaderboard.mockResolvedValue(BOARD);
    const page = await mount(<MonthlyCtfPage />, "/monthly-ctf");
    expect(api.fetchSeasonLeaderboard).toHaveBeenCalledWith("2026-11", { limit: 10 });
    const signIn = page.all((node) => node.props?.href === "/login?next=%2Fmonthly-ctf%2Fplay" || node.props?.to === "/login?next=%2Fmonthly-ctf%2Fplay");
    expect(signIn.length).toBeGreaterThan(0);
    expect(page.text()).toContain("LunarLedger17");
  });

  it("play page: a wrong then a right answer, announced politely", async () => {
    auth.value = { user: { id: 7 } };
    api.fetchCurrentSeason.mockResolvedValue({ season: SEASON, rewards: DEFAULT_REWARDS });
    api.fetchSeasonLeaderboard.mockResolvedValue(BOARD);
    api.fetchMySeasonSummary.mockResolvedValue({ handle: "LunarLedger17", display_name: "LunarLedger17", cosmetics: {}, streak_months: 0, seasons_solved: 0, xp_earned: 0, trophies: [], badges: [], cosmetic_rewards: [], certificates: [] });
    api.submitSeasonAnswer
      .mockResolvedValueOnce({ message: "Not quite. Each wrong answer adds the time penalty.", data: { correct: false } })
      .mockResolvedValueOnce({ message: "Correct. Your time is on the board.", data: { correct: true, rank: 2 } });
    const page = await mount(<MonthlyCtfPlayPage />, "/monthly-ctf/play");
    expect(page.text()).toContain("On what date was it taken?");
    const input = page.find((node) => node.type === "input" && node.props?.name === "answer");
    const form = page.find((node) => node.type === "form");
    await act(async () => input.props.onChange({ target: { value: "2020-01-01" } }));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    await flush();
    expect(api.submitSeasonAnswer).toHaveBeenLastCalledWith("2026-11", "2020-01-01");
    expect(page.text()).toContain("Not correct");
    const input2 = page.find((node) => node.type === "input" && node.props?.name === "answer");
    await act(async () => input2.props.onChange({ target: { value: "2021-03-04" } }));
    await act(async () => page.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }));
    await flush();
    expect(page.text()).toContain("Correct. Your time is on the board.");
    const status = page.find((node) => node.props?.role === "status" && node.props?.["aria-live"] === "polite");
    expect(status).toBeTruthy();
  });

  it("play page: an empty answer never reaches the server", async () => {
    auth.value = { user: { id: 7 } };
    api.fetchCurrentSeason.mockResolvedValue({ season: SEASON, rewards: [] });
    api.fetchSeasonLeaderboard.mockResolvedValue(BOARD);
    api.fetchMySeasonSummary.mockResolvedValue(null);
    const page = await mount(<MonthlyCtfPlayPage />, "/monthly-ctf/play");
    await act(async () => page.find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }));
    expect(api.submitSeasonAnswer).not.toHaveBeenCalled();
    expect(page.text()).toContain("Type your answer first.");
  });

  it("hall of fame: podium with words and ranks 4-10 as rows", async () => {
    api.fetchHallOfFame.mockResolvedValue({
      seasons: [
        {
          slug: "2026-10",
          title: "The Lost Ferry",
          month: "October 2026",
          solvers: 12,
          finalised_at: "2026-11-01T00:00:00Z",
          finalists: [1, 2, 3, 4].map((rank) => ({ rank, name: `Agent${rank}`, solve_seconds: rank * 100, wrong_attempts: 0, score_seconds: rank * 100, tier: { 1: "gold", 2: "silver", 3: "bronze" }[rank] || "" })),
        },
      ],
    });
    const page = await mount(<MonthlyCtfHallOfFamePage />, "/monthly-ctf/hall-of-fame");
    const words = page.text();
    expect(words).toContain("Season Champion");
    expect(words).toContain("Silver · 2nd");
    expect(words).toContain("Agent4");
    expect(words).toContain("12 students solved this case.");
  });
});

describe("useMyCosmetics", () => {
  beforeEach(() => {
    resetCosmeticsCache();
    api.fetchCosmetics.mockReset();
  });

  function Probe({ user }) {
    const cosmetics = useMyCosmetics(user);
    return <span data-aura={String(cosmetics.aura)} />;
  }

  it("fetches nothing while the switch is off or for another user", async () => {
    auth.value = { user: { id: 7, capabilities: { features: { monthly_ctf: { enabled: false } } } } };
    const tree = await renderTree(<Probe user={{ id: 7 }} />);
    await flush();
    auth.value = { user: { id: 7, capabilities: { features: { monthly_ctf: { enabled: true } } } } };
    const other = await renderTree(<Probe user={{ id: 8 }} />);
    await flush();
    expect(api.fetchCosmetics).not.toHaveBeenCalled();
    await tree.unmount();
    await other.unmount();
  });

  it("loads the viewer's aura once and shares it", async () => {
    auth.value = { user: { id: 7, capabilities: { features: { monthly_ctf: { enabled: true } } } } };
    api.fetchCosmetics.mockResolvedValue({ users: { 7: { aura: true } } });
    const one = await renderTree(<Probe user={{ id: 7 }} />);
    const two = await renderTree(<Probe user={{ id: 7 }} />);
    await flush();
    expect(api.fetchCosmetics).toHaveBeenCalledTimes(1);
    expect(one.find((node) => node.type === "span").props["data-aura"]).toBe("true");
    await one.unmount();
    await two.unmount();
  });
});
