// Level chart and the level-up moment (owner rules B). OWNER: WS-LEARN.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LEVELS, levelUpPending } from "./engagementModel";
import { LevelUpPanel } from "./LevelUpMoment";
import { EarnTable, LevelLadder, LevelPosition } from "./LevelsPage";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/levels">{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const CHART_LEVELS = LEVELS.map((level, index) => ({
  ...level,
  unlocks: index === 0 ? ["Your XP, streak and batch leaderboard place"] : ["Rank certificate anyone can verify"],
  reached: index <= 1,
  current: index === 1,
}));

describe("level chart", () => {
  it("mirrors the re-balanced backend curve", () => {
    expect(LEVELS.map((level) => level.min_xp)).toEqual([0, 1500, 3500, 6000, 9000, 12000, 15500, 19000]);
    expect(LEVELS).toHaveLength(8);
  });

  it("lists every rank with its threshold, unlocks and the current step", () => {
    const html = render(<LevelLadder levels={CHART_LEVELS} />);
    expect(text(html)).toContain("Elite Operator");
    expect(text(html)).toContain("19,000 XP");
    expect(text(html)).toContain("Rank certificate anyone can verify");
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(text(html)).toContain("You are here");
  });

  it("shows how to earn XP from the server's rows", () => {
    const html = render(
      <EarnTable rows={[{ key: "live_attended", label: "Attend a live class (40+ live minutes)", xp: 150 }, { key: "subscription_charge", label: "Each paid membership month", xp: 250, example: "Rs 500 plan" }]} />,
    );
    expect(text(html)).toContain("+150");
    expect(text(html)).toContain("Rs 500 plan");
    expect(render(<EarnTable rows={[]} />)).toBe("");
  });

  it("states the viewer's position", () => {
    const me = { xp: 2000, level: LEVELS[1], next_level: LEVELS[2], xp_to_next_level: 1500 };
    expect(text(render(<LevelPosition me={me} />))).toContain("1,500 XP to Operator");
    expect(text(render(<LevelPosition me={{ xp: 20000, level: LEVELS[7], next_level: null }} />))).toContain("highest rank");
  });
});

describe("level-up moment", () => {
  it("is pending only when the server says so", () => {
    expect(levelUpPending({ level: LEVELS[1], level_up: { pending: true } })).toBe(true);
    expect(levelUpPending({ level: LEVELS[1], level_up: { pending: false } })).toBe(false);
    expect(levelUpPending(null)).toBe(false);
  });

  it("celebrates the new rank with a way to the chart and a close button", () => {
    const onClose = vi.fn();
    const html = render(<LevelUpPanel level={LEVELS[2]} xp={3600} onClose={onClose} />);
    expect(text(html)).toContain("You reached");
    expect(text(html)).toContain("Operator");
    expect(html).toContain('href="/levels"');
    expect(html).toContain('role="dialog"');
  });
});
