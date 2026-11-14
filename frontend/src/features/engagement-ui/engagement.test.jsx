// Engagement UI (XP, streaks, badges, leaderboard, achievements). OWNER: WS-LEARN.
// Contract: scratchpad/engagement-notes.md §9 + shapes.json.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { act, fire, renderTree } from "../../test-utils/renderTree";
import { BadgesPanel, CertificatesPanel, EngagementOff, LevelCard, RanksPanel } from "./AchievementsPage";
import { isEngagementDisabledError, parseEngagementHeader } from "./engagementApi";
import {
  badgeGlyph,
  describeStreak,
  formatStudyTime,
  formatXp,
  levelProgress,
  splitBadges,
  tierInfo,
  verifyHref,
} from "./engagementModel";
import { BadgeMedal, ProgressRing, StatStrip, StreakChip, XpChip } from "./EngagementParts";
import { createEngagementStore, selectSummary } from "./engagementStore";
import { Board } from "./LeaderboardPage";
import { engagementPublicRoutes, engagementShellRoutes } from "./routes";
import { TabBar } from "./Tabs";
import { PRESENCE_INTERVAL_MS, startPresenceLoop } from "./useLivePresence";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/achievements">{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const ME = {
  xp: 295,
  level: { number: 2, key: "operative", title: "Operative", min_xp: 250 },
  next_level: { number: 3, key: "operator", title: "Operator", min_xp: 750 },
  streak: { current: 2, best: 2, alive: true, studied_today: true, freeze_available: true, freeze_covering: null },
  version: 2,
};

const BADGES = [
  { key: "first_lecture", title: "First Lecture", description: "Complete your first lecture.", tier: "bronze", earned: true, earned_at: "2026-11-14T18:11:19Z" },
  { key: "lecture_10", title: "Ten Down", description: "Complete 10 lectures.", tier: "silver", earned: false, earned_at: null },
];

const BOARD = {
  batch: { id: 1, title: "OSINT Foundations", batch: "Batch 7" },
  participants: 2,
  entries: [
    { rank: 1, display_name: "A.K.", xp: 295, level: ME.level, is_me: true },
    { rank: 2, display_name: "B.S.", xp: 40, level: { number: 1, title: "Recruit" }, is_me: false },
  ],
  me: { rank: 1, xp: 295, visible: true, display_name: "A.K." },
};

describe("engagement model", () => {
  it("formats XP, study time and tiers without hue", () => {
    expect(formatXp(12345)).toBe("12,345");
    expect(formatXp(-3)).toBe("0");
    expect(formatStudyTime(2700)).toBe("45 min");
    expect(formatStudyTime(7500)).toBe("2 h 05 min");
    expect(tierInfo("gold")).toEqual({ label: "Gold", pips: 3 });
    expect(tierInfo("unknown")).toEqual({ label: "", pips: 0 });
    expect(badgeGlyph("streak_7")).toBe("streak");
    expect(badgeGlyph("exam_ace")).toBe("exam");
    expect(badgeGlyph("first_lecture")).toBe("lecture");
  });

  it("measures level progress and streak words", () => {
    const progress = levelProgress(295, ME.level, ME.next_level);
    expect(progress.remaining).toBe(455);
    expect(progress.percent).toBeGreaterThan(0);
    expect(progress.percent).toBeLessThan(100);
    expect(describeStreak(ME.streak)).toMatchObject({ count: 2, label: "2-day streak" });
    expect(describeStreak(null).count).toBe(0);
  });

  it("splits badges into earned (newest first) and locked", () => {
    const { earned, locked, total } = splitBadges([...BADGES, null, { title: "no key" }]);
    expect(earned.map((badge) => badge.key)).toEqual(["first_lecture"]);
    expect(locked.map((badge) => badge.key)).toEqual(["lecture_10"]);
    expect(total).toBe(2);
  });

  it("prefers the API verify_url for share links", () => {
    expect(verifyHref({ verify_url: "https://x.test/achievements/a", slug: "a" })).toBe("https://x.test/achievements/a");
    expect(verifyHref({ slug: "abc" }, "https://site.test")).toBe("https://site.test/achievements/abc");
  });
});

describe("engagement API helpers", () => {
  it("parses the X-Engagement header defensively", () => {
    expect(parseEngagementHeader('{"pending_xp":20,"xp":130,"version":7,"streak":{"current":3}}')).toMatchObject({
      pendingXp: 20,
      xp: 130,
      version: 7,
      streak: { current: 3 },
    });
    expect(parseEngagementHeader("not json")).toBeNull();
    expect(parseEngagementHeader("")).toBeNull();
  });

  it("recognises the switched-off answer", () => {
    expect(isEngagementDisabledError({ response: { status: 403, data: { code: "feature_disabled" } } })).toBe(true);
    expect(isEngagementDisabledError({ response: { status: 403, data: { code: "permission_denied" } } })).toBe(false);
    expect(isEngagementDisabledError({ response: { status: 500 } })).toBe(false);
  });
});

function makeStore(fetchMe) {
  let clock = 1_000;
  const store = createEngagementStore({
    api: { fetchMe },
    now: () => clock,
    win: null,
    doc: null,
    watchHeader: () => {},
  });
  return { store, tick: (ms) => (clock += ms) };
}

describe("engagement store (contract §9: no tight polling, ETag, switch off)", () => {
  it("loads once, then re-validates with the ETag and keeps data on 304", async () => {
    const fetchMe = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, etag: '"v2"', data: ME })
      .mockResolvedValueOnce({ status: 304, etag: '"v2"', data: null });
    const { store } = makeStore(fetchMe);
    store.start(7);
    await store.refresh();
    expect(store.getState().status).toBe("ready");
    await store.refresh();
    expect(fetchMe).toHaveBeenLastCalledWith({ etag: '"v2"' });
    expect(store.getState().data.xp).toBe(295);
    store.stop();
  });

  it("goes quiet when the switch answers 403 feature_disabled", async () => {
    const fetchMe = vi.fn().mockRejectedValue({ response: { status: 403, data: { code: "feature_disabled" } } });
    const { store } = makeStore(fetchMe);
    store.start(7);
    await store.refresh();
    expect(store.getState().status).toBe("disabled");
    await store.refresh();
    expect(fetchMe).toHaveBeenCalledTimes(1);
    store.stop();
  });

  it("applies the X-Engagement header optimistically and raises one gain", async () => {
    const fetchMe = vi.fn().mockResolvedValue({ status: 200, etag: '"v2"', data: ME });
    const { store } = makeStore(fetchMe);
    store.start(7);
    await store.refresh();
    store.applyHeader({ pendingXp: 20, xp: 295, level: null, streak: { current: 3, alive: true }, version: 3 });
    const summary = selectSummary(store.getState());
    expect(summary).toMatchObject({ xp: 315, pending: true, streak: { current: 3 } });
    expect(store.getState().gain).toMatchObject({ xp: 20 });
    // An older header never overrides newer server data.
    store.applyHeader({ pendingXp: 50, xp: 0, version: 1 });
    expect(selectSummary(store.getState()).xp).toBe(315);
    store.stop();
  });
});

describe("engagement parts (palette law: state = icon + word + solid/dashed)", () => {
  it("medals: earned solid with pips, locked dashed with a lock", () => {
    const earned = renderToStaticMarkup(<BadgeMedal badgeKey="exam_ace" tier="gold" earned />);
    const locked = renderToStaticMarkup(<BadgeMedal badgeKey="exam_ace" tier="gold" />);
    expect(earned).toContain("is-earned");
    expect((earned.match(/eg-medal__pip/g) || []).length).toBe(3);
    expect(locked).toContain("is-locked");
    expect(earned).toContain('aria-hidden="true"');
  });

  it("chips, ring and strip carry real text", () => {
    expect(text(renderToStaticMarkup(<XpChip xp={1295} />))).toContain("1,295 XP");
    expect(renderToStaticMarkup(<XpChip xp={10} pending />)).toContain("(updating)");
    expect(text(renderToStaticMarkup(<StreakChip streak={{ current: 1, alive: true }} />))).toContain("1 day study streak");
    expect(renderToStaticMarkup(<StreakChip streak={{ current: 0, alive: false }} />)).toContain("is-idle");
    expect(renderToStaticMarkup(<ProgressRing value={40} label="Operator" />)).toContain('aria-label="Operator: 40%"');
    const strip = renderToStaticMarkup(<StatStrip items={[{ label: "Streak", value: "2", hint: "days" }]} />);
    expect(strip).toContain("<dt");
    expect(text(strip)).toContain("Streak 2 days");
    expect(renderToStaticMarkup(<StatStrip items={[]} />)).toBe("");
  });

  it("level card names the next rank and the XP to go", () => {
    const html = text(render(<LevelCard data={ME} summary={{ xp: 295, level: ME.level }} />));
    expect(html).toContain("Operative");
    expect(html).toContain("455 XP to Operator");
  });

  it("switched-off panel explains itself and links home", () => {
    const html = render(<EngagementOff />);
    expect(html).toContain("switched off");
    expect(html).toContain('href="/console"');
  });
});

describe("Achievements panels", () => {
  it("badge cabinet: earned with date, locked with criteria and the word Locked", () => {
    const html = render(<BadgesPanel catalogue={{ status: "ready", data: { badges: BADGES } }} />);
    expect(html).toContain("eg-badge is-earned");
    expect(html).toContain("eg-badge is-locked");
    expect(text(html)).toContain("Earned 14 Nov 2026");
    expect(text(html)).toContain("To earn: Complete 10 lectures.");
    expect(text(html)).toContain("Locked");
  });

  it("badge cabinet: loading, error and empty states", () => {
    expect(render(<BadgesPanel catalogue={{ status: "loading", data: null }} />)).toContain("Loading badges");
    const error = render(<BadgesPanel catalogue={{ status: "error", error: "Offline", reload: () => {} }} />);
    expect(error).toContain('role="alert"');
    expect(error).toContain("Try again");
    expect(render(<BadgesPanel catalogue={{ status: "ready", data: { badges: [BADGES[1]] } }} />)).toContain("Your first badge arrives");
  });

  it("rank ladder marks the current rank as the step you are on", () => {
    const html = render(<RanksPanel xp={1795} levelNumber={2} />);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("You are here");
    expect((html.match(/is-passed/g) || []).length).toBe(1);
    expect(text(html)).toContain("1,705 XP to go"); // Operator at 3,500 XP (economy v2 curve)
  });

  it("certificates: valid rows download and share; revoked rows say so", () => {
    const rows = [
      { slug: "a", kind: "badge", key: "exam_ace", tier: "gold", title: "Exam Ace", valid: true, earned_at: "2026-11-14T18:11:19Z", certificate_url: "/api/x.pdf", share_card_url: "/api/x.png", verify_url: "https://site.test/achievements/a" },
      { slug: "b", kind: "level", key: "operative", title: "Operative", valid: false },
    ];
    const html = render(<CertificatesPanel achievements={{ status: "ready", data: { achievements: rows } }} />);
    expect(html).toContain('href="/api/x.pdf"');
    expect(html).toContain("Copy link");
    expect(html).toContain("Revoked: this certificate no longer verifies.");
    expect(render(<CertificatesPanel achievements={{ status: "ready", data: { achievements: [] } }} />)).toContain("public link");
  });
});

describe("Leaderboard board", () => {
  it("marks the viewer's row with a You chip and aria-current", () => {
    const html = render(<Board data={BOARD} period="week" />);
    expect(html).toContain('class="is-me" aria-current="true"');
    expect(text(html)).toContain("A.K. You");
    expect(html).toContain('scope="row"');
    expect(html).toContain("OSINT Foundations · Batch 7 leaderboard, this week");
  });

  it("shows a detached You row when the viewer is off the visible page", () => {
    const data = { ...BOARD, entries: [BOARD.entries[1]], me: { rank: 14, xp: 3, visible: false } };
    const html = render(<Board data={data} period="all" />);
    expect(html).toContain("is-me is-detached");
    expect(text(html)).toContain("You (hidden from others)");
    expect(text(html)).toContain("14");
  });

  it("empty boards explain how to get on them", () => {
    expect(render(<Board data={{ ...BOARD, entries: [] }} period="week" />)).toContain("Finish a lesson to open the board");
  });
});

describe("Tabs (WAI-ARIA, roving focus)", () => {
  it("arrow keys move the selection and wrap", async () => {
    const onChange = vi.fn();
    const tabs = [
      { key: "badges", label: "Badges" },
      { key: "ranks", label: "Ranks" },
    ];
    const tree = await renderTree(<TabBar tabs={tabs} value="badges" onChange={onChange} label="Achievements" idPrefix="t" />);
    const first = tree.find((node) => node.props.role === "tab" && node.props["aria-selected"] === true);
    expect(first.props.tabIndex).toBe(0);
    await fire(first, "onKeyDown", { key: "ArrowRight", preventDefault() {} });
    expect(onChange).toHaveBeenLastCalledWith("ranks");
    await fire(first, "onKeyDown", { key: "ArrowLeft", preventDefault() {} });
    expect(onChange).toHaveBeenLastCalledWith("ranks");
    await act(async () => {});
  });
});

describe("engagement routes", () => {
  it("exposes the Console pages and the public verification page", () => {
    expect(engagementShellRoutes().map((route) => route.props.path)).toEqual(["/achievements", "/leaderboard", "/levels"]);
    expect(engagementPublicRoutes().map((route) => route.props.path)).toEqual(["/achievements/:slug"]);
  });
});

describe("live presence ping (contract: once a minute while visible)", () => {
  function fakeEnv() {
    const listeners = {};
    const intervals = [];
    const doc = {
      visibilityState: "visible",
      addEventListener: (name, fn) => (listeners[name] = fn),
      removeEventListener: (name) => delete listeners[name],
    };
    const win = { setInterval: (fn) => intervals.push(fn) && intervals.length, clearInterval: (id) => (intervals[id - 1] = null) };
    return { doc, win, listeners, intervals };
  }

  it("pings at once, then at most every 60 s, and only while visible", async () => {
    const { doc, win, listeners, intervals } = fakeEnv();
    let clock = 0;
    const post = vi.fn().mockResolvedValue({});
    const stop = startPresenceLoop(42, { post, doc, win, now: () => clock });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(42);
    clock += 10_000;
    listeners.visibilitychange();
    expect(post).toHaveBeenCalledTimes(1);
    clock += PRESENCE_INTERVAL_MS;
    doc.visibilityState = "hidden";
    intervals[0]();
    expect(post).toHaveBeenCalledTimes(1);
    doc.visibilityState = "visible";
    intervals[0]();
    expect(post).toHaveBeenCalledTimes(2);
    stop();
    expect(listeners.visibilitychange).toBeUndefined();
  });

  it("stops for good when the switch answers 403 feature_disabled", async () => {
    const { doc, win, listeners } = fakeEnv();
    const post = vi.fn().mockRejectedValue({ response: { status: 403, data: { code: "feature_disabled" } } });
    startPresenceLoop(7, { post, doc, win, now: () => 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(listeners.visibilitychange).toBeUndefined();
  });

  it("does nothing without a session", () => {
    const post = vi.fn();
    startPresenceLoop(null, { post, ...fakeEnv() })();
    expect(post).not.toHaveBeenCalled();
  });
});
