// Hall of Fame (hybrid release): the Friday 13 Nov page with its curated
// Batch 1 and 2, plus every later batch from the API, by chosen handle only.
import { StaticRouter } from "react-router-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../test-utils/renderTree";

const api = vi.hoisted(() => ({ fetchHallOfFame: vi.fn() }));
vi.mock("../features/certification/certificationApi", () => api);

import HallOfFamePage, { groupHallOfFameEntries } from "./HallOfFamePage";

const ENTRY = (id, handle, group = "Batch 3", extra = {}) => ({ id, handle, group, batch: group, ...extra });

describe("groupHallOfFameEntries", () => {
  it("keeps chosen handles only, skips the curated batches and orders batches by number", () => {
    const groups = groupHallOfFameEntries([
      ENTRY(1, "night_owl", "Batch 4"),
      ENTRY(2, "operative_a1b2c3", "Batch 3"),
      ENTRY(3, "", "Batch 3"),
      ENTRY(4, "Spectre", "Batch 2"),
      ENTRY(5, "tracer", "Batch 3"),
      ENTRY(6, "tracer", "Batch 3"),
      ENTRY(7, "loner", ""),
    ]);
    expect(groups).toEqual([
      { name: "Batch 3", students: ["tracer"] },
      { name: "Batch 4", students: ["night_owl"] },
      { name: "Graduates", students: ["loner"] },
    ]);
  });
});

describe("HallOfFamePage", () => {
  let tree;
  beforeEach(() => {
    api.fetchHallOfFame.mockReset();
  });
  afterEach(async () => {
    await tree?.unmount?.();
    tree = null;
  });

  const flush = () =>
    act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

  it("shows the Friday batches and appends later batches from every API page", async () => {
    api.fetchHallOfFame
      .mockResolvedValueOnce({ entries: [ENTRY(1, "tracer"), ENTRY(2, "Araxis", "Batch 1")], has_more: true })
      .mockResolvedValueOnce({ entries: [ENTRY(3, "night_owl")], has_more: false });
    tree = await renderTree(
      <StaticRouter location="/hall-of-fame">
        <HallOfFamePage />
      </StaticRouter>
    );
    await flush();
    expect(api.fetchHallOfFame).toHaveBeenNthCalledWith(1, { page: 1 });
    expect(api.fetchHallOfFame).toHaveBeenNthCalledWith(2, { page: 2 });
    const text = tree.text();
    expect(text).toContain("Batch 1");
    expect(text).toContain("Batch 2");
    expect(text).toContain("Batch 3");
    expect(text).toContain("2 certified");
    expect(text).toContain("tracer");
    expect(text).toContain("night_owl");
    expect(text.indexOf("Batch 2")).toBeLessThan(text.indexOf("Batch 3"));
  });

  it("keeps the curated batches when the API fails", async () => {
    api.fetchHallOfFame.mockImplementation(async () => {
      throw new Error("down");
    });
    tree = await renderTree(
      <StaticRouter location="/hall-of-fame">
        <HallOfFamePage />
      </StaticRouter>
    );
    await flush();
    const text = tree.text();
    expect(text).toContain("Batch 1");
    expect(text).toContain("STOIC MURDOCK");
    expect(text).not.toContain("Batch 3");
  });
});
