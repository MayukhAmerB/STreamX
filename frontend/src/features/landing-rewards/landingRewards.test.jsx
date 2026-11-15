// Signed-in rewards showcase on the Friday landing: the compact "Your
// progress" card under the hero, the richer card inside the reward band, the
// rank emblems, and the privacy rule (handle only, never a real name).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ auth: { isAuthenticated: false, user: null }, engagement: true }));

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => state.auth }));
vi.mock("../engagement-ui/useEngagement", () => ({ default: () => ({ enabled: false }), useEngagementEnabled: () => state.engagement }));
vi.mock("../engagement-ui/engagementApi", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEngagementMe: vi.fn(),
  fetchLeaderboard: vi.fn(),
}));
vi.mock("../rewards/rewardsApi", async (importOriginal) => ({ ...(await importOriginal()), fetchRewardHistory: vi.fn() }));
vi.mock("../profiles/profilesApi", () => ({ fetchMyProfile: vi.fn() }));

import { act, renderTree } from "../../test-utils/renderTree";
import { fetchEngagementMe, fetchLeaderboard } from "../engagement-ui/engagementApi";
import { LEVELS } from "../engagement-ui/engagementModel";
import { fetchMyProfile } from "../profiles/profilesApi";
import LandingRewardsBand from "../rewards/LandingRewardsBand";
import { fetchRewardHistory } from "../rewards/rewardsApi";
import LandingRewardsCard from "./LandingRewardsCard";
import { buildRewardsView, cheerLine, formatHandle, meterSegments, rankNumber, romanRank } from "./landingRewardsModel";
import RankEmblem from "./RankEmblem";
import { resetLandingRewardsCache } from "./useLandingRewards";

const NOW = Date.parse("2026-11-16T09:00:00Z");
const STUDENT = { id: 7, full_name: "Asha Rao", first_name: "Asha", last_name: "Rao", email: "asha.rao@example.com", role: "student" };

const ME = {
  xp: 4870,
  weekly_xp: 320,
  level: { number: 3, key: "operator", title: "Operator", min_xp: 3500 },
  next_level: { number: 4, key: "analyst", title: "Analyst", min_xp: 6000 },
  level_progress: 0.548,
  level_up: { pending: false },
  badges: [
    { key: "first_lecture", title: "First Lecture", tier: "bronze", earned_at: "2026-10-02T10:00:00+00:00" },
    { key: "streak_7", title: "Week Warrior", tier: "silver", earned_at: "2026-11-14T10:00:00+00:00" },
    { key: "first_report", title: "First Report", tier: "bronze", earned_at: "2026-10-20T10:00:00+00:00" },
  ],
};
const BOARD = {
  participants: 24,
  me: { rank: 2, xp: 320, handle: "geo_hound", display_name: "geo_hound", visible: true },
};
const HISTORY = {
  summary: { total_xp: 4870, level: 3, badges_count: 3 },
  badges: [],
  certificates: [
    { reference: "ASI-2026-OSINT-000042-7", title: "Certified OSINT Investigator", type_label: "OSINT certification", issued_at: "2026-09-01T00:00:00Z", valid: true, url: "/certificates/ASI-2026-OSINT-000042-7" },
  ],
};

const textOfTree = (tree) => tree.text();
const hrefs = (tree) => tree.all((node) => node.type === "a").map((node) => node.props.href);

async function mount(node) {
  const tree = await renderTree(<MemoryRouter initialEntries={["/"]}>{node}</MemoryRouter>);
  for (let index = 0; index < 4; index += 1) await act(async () => {});
  return tree;
}

beforeEach(() => {
  resetLandingRewardsCache();
  vi.mocked(fetchEngagementMe).mockReset().mockResolvedValue({ status: 200, etag: "", data: ME });
  vi.mocked(fetchLeaderboard).mockReset().mockResolvedValue({ status: 200, etag: "", data: BOARD });
  vi.mocked(fetchRewardHistory).mockReset().mockResolvedValue(HISTORY);
  vi.mocked(fetchMyProfile).mockReset().mockResolvedValue({ handle: "geo_hound", full_name: "Asha Rao" });
  state.auth = { isAuthenticated: true, user: STUDENT };
  state.engagement = true;
});

describe("landing rewards: signed-in student", () => {
  it("renders the compact card under the hero with rank badge, XP, week, badges and Certified", async () => {
    const tree = await mount(<LandingRewardsCard variant="compact" />);
    const text = textOfTree(tree);

    expect(tree.find((node) => node.props?.["data-testid"] === "landing-rewards-card")).toBeTruthy();
    expect(text).toContain("Your progress");
    expect(text).toContain("@geo_hound");
    expect(text).toContain("Operator");
    expect(text).toContain("Rank III of 8");
    expect(text).toContain("4,870");
    expect(text).toContain("+320");
    expect(text).toContain("#2 of 24");
    expect(text).toContain("1,130 XP to Analyst");
    expect(text).toContain("Certified");
    // The newest badge leads, and drives the congratulatory line.
    expect(text).toContain("New badge: Week Warrior (Silver). Well earned.");
    expect(text).toContain("Week Warrior");

    const emblem = tree.find((node) => node.type === "svg" && node.props["data-rank"] === 3);
    expect(emblem.props["aria-label"]).toBe("Rank III: Operator");
    const meter = tree.find((node) => node.props?.className === "lr-meter");
    expect(meter.props["aria-label"]).toBe("55% of the way from Operator to Analyst");
    expect(meter.props["data-filled"]).toBe(5);

    expect(hrefs(tree)).toEqual(expect.arrayContaining(["/achievements", "/profile/public?tab=certificates"]));
    expect(text).toContain("View all rewards");
    // The leaderboard was read for this week, with the existing client.
    expect(fetchLeaderboard).toHaveBeenCalledWith({ period: "week" });
  });

  it("never renders the real name or e-mail", async () => {
    const tree = await mount(
      <>
        <LandingRewardsCard variant="compact" />
        <LandingRewardsBand />
      </>
    );
    const text = textOfTree(tree);
    expect(text).toContain("@geo_hound");
    for (const secret of ["Asha", "Rao", "asha.rao@example.com"]) expect(text).not.toContain(secret);
    const labels = tree.all((node) => node.props?.["aria-label"] || node.props?.title).map((node) => `${node.props["aria-label"] || ""} ${node.props.title || ""}`);
    for (const label of labels) expect(label).not.toMatch(/Asha|Rao/);
  });

  it("shows the richer card inside the reward band, and one request round for both cards", async () => {
    const tree = await mount(
      <>
        <LandingRewardsCard variant="compact" />
        <LandingRewardsBand />
      </>
    );
    const full = tree.find((node) => node.props?.["data-testid"] === "landing-rewards-full");
    expect(full).toBeTruthy();
    const text = textOfTree(tree);
    expect(text).toContain("Latest badges · 3 earned");
    expect(text).toContain("First Report");
    expect(text).toContain("Weekly leaderboard");
    expect(text).toContain("Analyst at 6,000 XP");
    expect(text).not.toContain("Sign in to see your rank");
    expect(fetchEngagementMe).toHaveBeenCalledTimes(1);
    expect(fetchLeaderboard).toHaveBeenCalledTimes(1);
    expect(fetchRewardHistory).toHaveBeenCalledTimes(1);
    // The leaderboard already gave the handle: no profile request.
    expect(fetchMyProfile).not.toHaveBeenCalled();
  });

  it("falls back to the profile handle when the student has no batch leaderboard", async () => {
    vi.mocked(fetchLeaderboard).mockResolvedValue({ status: 200, etag: "", data: { participants: 0, entries: [], me: null } });
    vi.mocked(fetchRewardHistory).mockResolvedValue({ ...HISTORY, certificates: [] });
    const tree = await mount(<LandingRewardsCard variant="compact" />);
    const text = textOfTree(tree);
    expect(text).toContain("@geo_hound");
    expect(text).toContain("Not ranked yet");
    expect(text).not.toContain("Certified");
    expect(hrefs(tree)).not.toContain("/profile/public?tab=certificates");
  });
});

describe("landing rewards: hidden", () => {
  it("renders nothing and requests nothing when signed out; the band offers sign-in", async () => {
    state.auth = { isAuthenticated: false, user: null };
    const tree = await mount(
      <>
        <LandingRewardsCard variant="compact" />
        <LandingRewardsBand />
      </>
    );
    const text = textOfTree(tree);
    expect(text).not.toContain("Your progress");
    expect(tree.find((node) => node.props?.["data-testid"] === "landing-rewards-card")).toBeNull();
    expect(tree.find((node) => node.props?.["data-testid"] === "landing-rewards-full")).toBeNull();
    expect(text).toContain("Sign in to see your rank");
    expect(hrefs(tree)).toContain("/login");
    expect(fetchEngagementMe).not.toHaveBeenCalled();
    expect(fetchLeaderboard).not.toHaveBeenCalled();
    expect(fetchRewardHistory).not.toHaveBeenCalled();
  });

  it("renders nothing for staff, or when the engagement switch is off", async () => {
    state.auth = { isAuthenticated: true, user: { id: 9, full_name: "Al Syed", role: "instructor" }, isInstructor: true };
    let tree = await mount(<LandingRewardsCard variant="compact" />);
    expect(tree.text()).toBe("");

    state.auth = { isAuthenticated: true, user: STUDENT };
    state.engagement = false;
    tree = await mount(<LandingRewardsCard variant="compact" />);
    expect(tree.text()).toBe("");
    expect(fetchEngagementMe).not.toHaveBeenCalled();
  });

  it("hides the card when /me fails (engagement disabled on the server)", async () => {
    vi.mocked(fetchEngagementMe).mockRejectedValue({ response: { status: 403, data: { code: "feature_disabled" } } });
    const tree = await mount(<LandingRewardsCard variant="compact" />);
    expect(tree.find((node) => node.props?.["data-testid"] === "landing-rewards-card")).toBeNull();
    expect(tree.find((node) => node.props?.["aria-busy"] === "true")).toBeNull();
  });
});

describe("landing rewards model", () => {
  it("formats handles and roman ranks", () => {
    expect(formatHandle("geo_hound")).toBe("@geo_hound");
    expect(formatHandle("@@geo")).toBe("@geo");
    expect(formatHandle("")).toBe("");
    expect(LEVELS.map((level) => romanRank(level.number))).toEqual(["I", "II", "III", "IV", "V", "VI", "VII", "VIII"]);
  });

  it("splits progress into 10 segments with the current one partly lit", () => {
    expect(meterSegments(55)).toEqual({ filled: 5, fractions: [1, 1, 1, 1, 1, 0.5, 0, 0, 0, 0] });
    expect(meterSegments(0).filled).toBe(0);
    expect(meterSegments(140).fractions.every((value) => value === 1)).toBe(true);
  });

  it("picks the congratulatory line from the latest achievement", () => {
    const base = buildRewardsView({ me: ME, board: BOARD, history: HISTORY }, { now: NOW });
    expect(base.cheer).toContain("Week Warrior");
    expect(cheerLine({ ...base, promoted: true }, NOW)).toBe("Promoted to Operator. Wear the new badge with pride.");
    const stale = { ...base, latest: { kind: "badge", title: "First Lecture", tier: "bronze", at: Date.parse("2026-01-01") } };
    expect(cheerLine({ ...stale, weekRank: 1 }, NOW)).toBe("Top of your batch this week. Hold the lead.");
    expect(cheerLine({ ...stale, weekRank: 3 }, NOW)).toBe("On the podium this week at #3. Great work.");
    expect(cheerLine({ ...stale, weekRank: 9, weeklyXp: 320 }, NOW)).toBe("320 XP this week. Your momentum shows.");
    const fresh = { ...base, latest: { kind: "certificate", title: "Certified OSINT Investigator", at: NOW - 1000 } };
    expect(cheerLine(fresh, NOW)).toBe("Certified: Certified OSINT Investigator. You earned every part of it.");
    const blank = { ...base, latest: null, weekRank: null, weeklyXp: 0, xp: 0 };
    expect(cheerLine(blank, NOW)).toBe("Your first XP is one lecture away.");
    expect(cheerLine({ ...blank, xp: 19500, next: null }, NOW)).toBe("Elite Operator: the top of the ladder. Outstanding.");
  });

  it("returns null without engagement data and ignores revoked certificates", () => {
    expect(buildRewardsView({})).toBeNull();
    const view = buildRewardsView({ me: ME, history: { certificates: [{ title: "Old", valid: false }] } }, { now: NOW });
    expect(view.certified).toBe(false);
    expect(view.weekRank).toBeNull();
    expect(view.weeklyXp).toBe(320);
  });
});

describe("rank emblems", () => {
  it("draws eight distinct emblems that grow more ornate with rank", () => {
    const markup = LEVELS.map((level) => renderToStaticMarkup(<RankEmblem number={level.number} title={level.title} />));
    expect(new Set(markup.map((html) => html.replace(/lr\dx[a-zA-Z0-9]*-/g, "id-"))).size).toBe(8);
    markup.forEach((html, index) => expect(html).toContain(`aria-label="Rank ${romanRank(index + 1)}: ${LEVELS[index].title}"`));
    markup.forEach((html, index) => expect(html).toContain(`data-rank="${index + 1}"`));
    const size = (html) => (html.match(/<(path|polygon|ellipse|line|circle|rect)\b/g) || []).length;
    expect(size(markup[7])).toBeGreaterThan(size(markup[0]) * 3);
    // Prestige: an aura on VII-VIII, the crowned starburst on VIII only.
    expect(markup.slice(0, 6).every((html) => !html.includes("lr-emblem__aura"))).toBe(true);
    expect(markup[6]).toContain("lr-emblem__aura");
    expect(markup[7]).toContain("lr-emblem__rays");
    expect(markup.slice(0, 7).every((html) => !html.includes("lr-emblem__rays"))).toBe(true);
    // No gold, amber or yellow (the owner's rule for the insignia).
    for (const html of markup) expect(html.toLowerCase()).not.toMatch(/f3e2b3|#e6d29c|gold|amber|yellow|#f4a62a/);
  });

  it("simplifies small sizes and namespaces its ids per instance", () => {
    const chip = renderToStaticMarkup(<RankEmblem number={8} title="Elite Operator" size={24} />);
    const full = renderToStaticMarkup(<RankEmblem number={8} title="Elite Operator" size={200} />);
    expect(chip).toContain('data-detail="compact"');
    expect(full).toContain('data-detail="full"');
    expect(chip).not.toContain("ELITE OPERATOR");
    expect(full).toContain("ELITE OPERATOR");
    expect(chip.length).toBeLessThan(full.length / 2);
    expect(renderToStaticMarkup(<RankEmblem number={4} size={64} />)).toContain('data-detail="standard"');
    const pair = renderToStaticMarkup(
      <>
        <RankEmblem number={3} />
        <RankEmblem number={3} />
      </>,
    );
    const ids = [...pair.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const decorative = renderToStaticMarkup(<RankEmblem number={2} decorative />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).not.toContain('role="img"');
  });

  it("finds the rank number from a number, key or title", () => {
    expect(rankNumber({ number: 5, title: "Specialist" })).toBe(5);
    expect(rankNumber({ title: "Senior Analyst" })).toBe(6);
    expect(rankNumber({ key: "lead_investigator" })).toBe(7);
    expect(rankNumber(null)).toBe(1);
  });

  it("only renders the shine layer when asked", () => {
    expect(renderToStaticMarkup(<RankEmblem number={5} />)).not.toContain("lr-emblem__shine");
    expect(renderToStaticMarkup(<RankEmblem number={5} shine />)).toContain("lr-emblem__shine");
  });
});

describe("wiring", () => {
  const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  it("puts the compact card right after the hero, before the YouTube section, for signed-in visitors only", () => {
    const source = read("../../pages/LandingPage.jsx");
    const heroEnd = source.indexOf("</section>", source.indexOf('className="landing-hero'));
    const card = source.indexOf('<LandingRewardsCard variant="compact" />');
    expect(card).toBeGreaterThan(heroEnd);
    expect(card).toBeLessThan(source.indexOf("<YouTubeSection />"));
    expect(source).toContain('{isOwlCognito || !isAuthenticated ? null : <LandingRewardsCard variant="compact" />}');
  });

  it("respects reduced motion and animates transform/opacity only", () => {
    const css = read("./landingRewards.css");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(':root[data-motion="reduce"]');
    const keyframes = css.match(/@keyframes[\s\S]*?\n}\n/g) || [];
    expect(keyframes.length).toBeGreaterThan(0);
    for (const block of keyframes) {
      const props = [...block.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((match) => match[1]);
      expect(props.every((prop) => prop === "transform" || prop === "opacity")).toBe(true);
    }
  });
});
