// Hall of Fame page: handles only (never real names), certificate links,
// counters with real numbers, grouping by batch, pagination, states.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fire, renderTree } from "../test-utils/renderTree";

const api = vi.hoisted(() => ({ fetchHallOfFame: vi.fn() }));
vi.mock("../features/certification/certificationApi", () => api);

import HallOfFamePage, { HallOfFameView, counterItems, formatAchievedOn, groupEntries } from "./HallOfFamePage";

const ENTRY = (id, handle, extra = {}) => ({
  id,
  handle,
  profile_url: null,
  batch: "Batch 7",
  group: "Batch 7",
  achievement: "Certified OSINT Investigator",
  achieved_on: "2026-11-14",
  year: 2026,
  band: "",
  certificate_reference: null,
  certificate_url: null,
  ...extra,
});

const DATA = {
  counters: { graduates: 3, batches: 2, verified_certificates: 2, since: 2025 },
  featured: {
    recent: [ENTRY(1, "asha_r", { profile_url: "/u/asha_r", certificate_url: "/certificates/ASI-2026-OSINT-000042-7", certificate_reference: "ASI-2026-OSINT-000042-7" })],
    top: [
      ENTRY(1, "asha_r", { band: "Distinction", certificate_url: "/certificates/ASI-2026-OSINT-000042-7" }),
      ENTRY(2, "night_owl", { band: "Merit" }),
    ],
  },
  batches: [
    { label: "Batch 7", count: 2 },
    { label: "Batch 2", count: 1 },
  ],
  entries: [
    ENTRY(1, "asha_r", { profile_url: "/u/asha_r", certificate_url: "/certificates/ASI-2026-OSINT-000042-7" }),
    ENTRY(2, "night_owl", { certificate_url: "/certificates/ASI-2026-OSINT-000043-5" }),
    ENTRY(3, "Araxis", { batch: "Batch 2", group: "Batch 2", achieved_on: null, achievement: "Certified student" }),
  ],
  page: 1,
  total: 3,
  has_more: false,
};

const render = (node) => renderToStaticMarkup(<StaticRouter location="/hall-of-fame">{node}</StaticRouter>);

describe("Hall of Fame helpers", () => {
  it("formats dates, groups by batch in order and keeps only real counters", () => {
    expect(formatAchievedOn("2026-11-14")).toBe("14 Nov 2026");
    expect(formatAchievedOn(null)).toBe("");
    expect(groupEntries(DATA.entries).map((group) => [group.key, group.entries.length])).toEqual([
      ["Batch 7", 2],
      ["Batch 2", 1],
    ]);
    expect(counterItems({ graduates: 0, batches: 1, verified_certificates: 0, since: null }).map((item) => item.label)).toEqual(["Batch"]);
  });
});

describe("HallOfFameView", () => {
  it("renders the monumental hero with one handwritten accent word and real counters", () => {
    const html = render(<HallOfFameView data={DATA} status="ready" />);
    expect(html).toContain('id="hof-title"');
    expect(html.match(/class="hp-hand hp-hand--accent"/g)).toHaveLength(1);
    expect(html).toContain("Certified graduates");
    expect(html).toContain(">3<");
    expect(html).toContain("Honoured since");
    expect(html).toContain(">2025<");
  });

  it("shows handles with profile and verified certificate links, grouped by batch", () => {
    const html = render(<HallOfFameView data={DATA} status="ready" />);
    expect(html).toContain("@asha_r");
    expect(html).toContain('href="/u/asha_r"');
    expect(html).toContain('href="/certificates/ASI-2026-OSINT-000042-7"');
    expect(html).toContain("Most recent graduates");
    expect(html).toContain("Top graduates");
    expect(html).toContain("Distinction");
    expect(html).toContain('id="hof-group-batch-7"');
    expect(html).toContain('id="hof-group-batch-2"');
    expect(html).toContain("2 certified");
    // No certificate, no link; no date, no date text.
    const araxis = html.slice(html.indexOf("@Araxis"));
    expect(araxis.slice(0, 400)).not.toContain("View certificate");
  });

  it("never renders a real name or e-mail even if the payload carried one", () => {
    const leaky = {
      ...DATA,
      entries: [{ ...DATA.entries[0], recipient_name: "Asha Rao", real_name: "Asha Rao", email: "asha@example.com" }],
    };
    const html = render(<HallOfFameView data={leaky} status="ready" />);
    expect(html).not.toContain("Asha Rao");
    expect(html).not.toContain("asha@example.com");
  });

  it("has calm empty, loading and error states", () => {
    const empty = render(<HallOfFameView data={{ counters: {}, featured: { recent: [], top: [] }, batches: [], entries: [] }} status="ready" />);
    expect(empty).toContain("The first names are being engraved.");
    expect(empty).not.toContain("Certified graduates");
    expect(render(<HallOfFameView data={null} status="loading" />)).toContain("Opening the Hall of Fame");
    expect(render(<HallOfFameView data={null} status="error" />)).toContain("Try again");
  });

  it("does not repeat the same people as top graduates", () => {
    const same = { ...DATA, featured: { recent: DATA.featured.recent, top: [DATA.featured.top[0]] } };
    expect(render(<HallOfFameView data={same} status="ready" />)).not.toContain("Top graduates");
  });

  it("offers batch filters and a show-more button only when useful", () => {
    const html = render(<HallOfFameView data={{ ...DATA, has_more: true }} status="ready" />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Show more graduates");
    const single = render(<HallOfFameView data={{ ...DATA, batches: [DATA.batches[0]] }} status="ready" />);
    expect(single).not.toContain('role="group"');
    expect(single).not.toContain("Show more graduates");
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

  const flush = () => act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  it("loads the first page, filters by batch and appends the next page", async () => {
    api.fetchHallOfFame
      .mockResolvedValueOnce({ ...DATA, has_more: true })
      .mockResolvedValueOnce({ ...DATA, entries: [ENTRY(9, "late_bloomer")], page: 2, has_more: false })
      .mockResolvedValueOnce({ ...DATA, entries: [DATA.entries[2]], batches: DATA.batches });
    tree = await renderTree(
      <StaticRouter location="/hall-of-fame">
        <HallOfFamePage />
      </StaticRouter>
    );
    await flush();
    expect(api.fetchHallOfFame).toHaveBeenCalledWith({ page: 1, batch: "" });
    expect(tree.text()).toContain("@night_owl");

    await fire(tree.getByLabel("button", "Show more graduates"), "onClick");
    await flush();
    expect(api.fetchHallOfFame).toHaveBeenLastCalledWith({ page: 2, batch: "" });
    expect(tree.text()).toContain("@late_bloomer");
    expect(tree.text()).toContain("@night_owl");

    await fire(tree.getByLabel("button", "Batch 2"), "onClick");
    await flush();
    expect(api.fetchHallOfFame).toHaveBeenLastCalledWith({ page: 1, batch: "Batch 2" });
  });

  it("shows the error state when the API fails", async () => {
    api.fetchHallOfFame.mockRejectedValue(new Error("down"));
    tree = await renderTree(
      <StaticRouter location="/hall-of-fame">
        <HallOfFamePage />
      </StaticRouter>
    );
    await flush();
    expect(tree.text()).toContain("could not be loaded");
  });
});
