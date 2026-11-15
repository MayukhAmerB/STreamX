// The level-up celebration (owner, Nov 2026): once per promotion, full screen,
// "LEVEL UP — <Rank>", XP total, what the next rank needs, Continue and View
// achievements; a static card under reduced motion. OWNER: WS-LEARN.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({ default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, user: { id: 42 } }) }));

import apiClient from "../../api/client";
import { resetDialogQueue, holdDialog } from "../app-shell/dialogQueue";
import { acknowledgeLevelUp } from "./engagementApi";
import { LevelUpCard, LevelUpGate } from "./LevelUpMoment";
import {
  celebrationDue,
  celebrationView,
  promotionSeenKey,
  rememberCelebrated,
  wasCelebrated,
} from "./levelUpModel";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/console">{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

function memoryStore() {
  const data = new Map();
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)) };
}

const ME_IV = {
  xp: 6250,
  level: { number: 4, key: "analyst", title: "Analyst", min_xp: 6000 },
  next_level: { number: 5, key: "specialist", title: "Specialist", min_xp: 9000 },
  xp_to_next_level: 2750,
  level_progress: 0.0833,
  level_up: { pending: true, from_level: { number: 3, key: "operator", title: "Operator", min_xp: 3500 } },
};

const ME_VIII = {
  xp: 19400,
  level: { number: 8, key: "elite_operator", title: "Elite Operator", min_xp: 19000 },
  next_level: null,
  xp_to_next_level: 0,
  level_progress: 1,
  level_up: { pending: true, from_level: { number: 7, key: "lead_investigator", title: "Lead Investigator", min_xp: 15500 } },
};

afterEach(() => {
  resetDialogQueue();
  vi.clearAllMocks();
});

describe("celebration model", () => {
  it("builds the card from /engagement/me/", () => {
    const view = celebrationView(ME_IV);
    expect(view.rank).toEqual({ number: 4, key: "analyst", title: "Analyst", roman: "IV" });
    expect(view.xpText).toBe("6,250 XP");
    expect(view.nextText).toBe("2,750 XP to Specialist (Rank V at 9,000 XP)");
    expect(celebrationView(ME_VIII).nextText).toMatch(/Top rank reached/);
    expect(celebrationView(null)).toBeNull();
  });

  it("is due once per promotion: the server flag, then a per-user, per-rank device marker", () => {
    const store = memoryStore();
    expect(celebrationDue(ME_IV, 42, store)).toBe(true);
    expect(celebrationDue({ ...ME_IV, level_up: { pending: false } }, 42, store)).toBe(false);
    rememberCelebrated(42, "analyst", store);
    expect(wasCelebrated(42, "analyst", store)).toBe(true);
    expect(celebrationDue(ME_IV, 42, store)).toBe(false);
    // Another student on the same device, or the next promotion, still celebrates.
    expect(celebrationDue(ME_IV, 7, store)).toBe(true);
    expect(celebrationDue({ ...ME_IV, level: { ...ME_IV.level, key: "specialist", number: 5, title: "Specialist" } }, 42, store)).toBe(true);
    expect(promotionSeenKey(42, "analyst")).toBe("eg:promotion-seen:42:analyst");
  });

  it("survives blocked storage", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(celebrationDue(ME_IV, 42, blocked)).toBe(true);
    expect(() => rememberCelebrated(42, "analyst", blocked)).not.toThrow();
  });

  it("acknowledges on the idempotent promotion-seen endpoint", async () => {
    apiClient.post.mockResolvedValue({ data: { success: true } });
    await acknowledgeLevelUp();
    expect(apiClient.post).toHaveBeenCalledWith("/engagement/me/promotion-seen/", {});
  });
});

describe("celebration card", () => {
  it("shows the new rank badge, LEVEL UP — rank, XP, the next rank and both actions", () => {
    const html = render(<LevelUpCard view={celebrationView(ME_IV)} onContinue={() => {}} onViewAchievements={() => {}} />);
    const words = text(html);
    expect(words).toContain("Level up");
    expect(words).toContain("Analyst");
    expect(words).toContain("Rank IV · LVL 4");
    expect(words).toContain("6,250 XP in total");
    expect(words).toContain("2,750 XP to Specialist");
    expect(html).toContain('data-rank="4"');
    expect(html).toContain('class="lr-emblem');
    expect(html).toMatch(/width="200"/);
    expect(html).toContain('href="/achievements"');
    expect(words).toContain("Continue");
    expect(words).toContain("View achievements");
    expect(html).toContain('id="eg-levelup-title"');
    expect(html).toContain('id="eg-levelup-desc"');
    // The burst: rays around the emblem (transform/opacity animation in CSS).
    expect(html.match(/class="eg-levelup__ray"/g)).toHaveLength(16);
  });

  it("is a static card under reduced motion: no burst, no glow ring, no sheen", () => {
    const html = render(<LevelUpCard view={celebrationView(ME_IV)} reducedMotion onContinue={() => {}} onViewAchievements={() => {}} />);
    expect(html).toContain("eg-levelup--static");
    expect(html).not.toContain("eg-levelup__ray");
    expect(html).not.toContain("eg-levelup__ring");
    expect(html).not.toContain("lr-emblem__shine");
    expect(text(html)).toContain("Analyst");
  });

  it("the top rank says so and has no meter", () => {
    const html = render(<LevelUpCard view={celebrationView(ME_VIII)} onContinue={() => {}} onViewAchievements={() => {}} />);
    expect(text(html)).toContain("Elite Operator");
    expect(text(html)).toContain("Top rank reached");
    expect(html).not.toContain("eg-levelup__meter");
    expect(html).toContain('data-rank="8"');
  });

  it("uses no gold, amber or yellow", () => {
    const html = render(<LevelUpCard view={celebrationView(ME_VIII)} onContinue={() => {}} onViewAchievements={() => {}} />);
    expect(html.toLowerCase()).not.toMatch(/gold|amber|yellow|#f3e2b3|#ffd700|#f5c518/);
  });
});

describe("celebration gate", () => {
  it("renders nothing when no promotion is pending or engagement is off", () => {
    expect(render(<LevelUpGate data={{ ...ME_IV, level_up: { pending: false } }} />)).toBe("");
    expect(render(<LevelUpGate data={ME_IV} enabled={false} />)).toBe("");
    expect(render(<LevelUpGate data={null} />)).toBe("");
  });

  it("waits for the journey welcome or the handle prompt to finish", () => {
    holdDialog("journey", { silent: true });
    expect(render(<LevelUpGate data={ME_IV} />)).toBe("");
  });
});
