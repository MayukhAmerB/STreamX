import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/client", () => ({ default: api }));

import { act, renderTree } from "../test-utils/renderTree";
import SiteStatStrip, { siteStatValues } from "./SiteStatStrip";
import { fetchSiteStats, honestCount, resetSiteStatsCache, siteStatItems } from "./siteStats";

const envelope = (stats) => ({ success: true, message: "Site figures fetched.", data: { stats, available: true, generated_at: "2026-11-15T10:00:00Z" }, errors: null });
const FULL = {
  students_enrolled: 134,
  live_classes_delivered: 52,
  recorded_hours: 87,
  certificates_issued: 1234,
  ctf_cases: 40,
  average_rating: 4.66,
  rating_count: 23,
};

afterEach(() => {
  resetSiteStatsCache();
  api.get.mockReset();
});

describe("honest formatting", () => {
  it("is exact below 100 and rounds down with '+' only when the real value is higher", () => {
    expect(honestCount(87).text).toBe("87");
    expect(honestCount(99).text).toBe("99");
    expect(honestCount(100).text).toBe("100");
    expect(honestCount(130).text).toBe("130");
    expect(honestCount(134).text).toBe("130+");
    expect(honestCount(139).text).toBe("130+");
    expect(honestCount(1000).text).toBe("1,000");
    expect(honestCount(1234).text).toBe("1,200+");
    expect(honestCount(12999).text).toBe("12,000+");
    for (const value of [5, 87, 119, 120, 134, 999, 1001, 45678]) {
      const { shown } = honestCount(value);
      expect(shown).toBeLessThanOrEqual(value);
    }
  });

  it("rejects non-numbers and negatives", () => {
    for (const value of [null, undefined, NaN, Infinity, -1, "120"]) expect(honestCount(value)).toBeNull();
  });
});

describe("siteStatItems", () => {
  it("keeps a fixed order and labels, from the envelope or its data", () => {
    const items = siteStatItems(envelope(FULL));
    expect(items.map((item) => [item.label, item.value])).toEqual([
      ["Students enrolled", "130+"],
      ["Live classes delivered", "52"],
      ["Hours of recorded classes", "87"],
      ["Certificates issued", "1,200+"],
      ["CTF challenges and cases", "40"],
      ["Average course rating", "4.6/5"],
    ]);
    expect(items.at(-1).note).toBe("from 23 reviews");
    expect(siteStatItems(envelope(FULL).data)).toEqual(items);
  });

  it("hides null, tiny and invalid figures and the rating below 10 reviews", () => {
    const items = siteStatItems(
      envelope({
        students_enrolled: null,
        live_classes_delivered: 9, // below the minimum of 10
        recorded_hours: -3,
        certificates_issued: "12",
        ctf_cases: 5,
        average_rating: 4.9,
        rating_count: 9,
      }),
    );
    expect(items.map((item) => item.key)).toEqual(["ctf_cases"]);
    expect(siteStatItems(envelope({ ...FULL, average_rating: null, rating_count: null })).map((item) => item.key)).not.toContain("average_rating");
    expect(siteStatItems(envelope({ ...FULL, average_rating: 7, rating_count: 40 })).map((item) => item.key)).not.toContain("average_rating");
  });

  it("never rounds the rating up", () => {
    expect(siteStatItems(envelope({ average_rating: 4.69, rating_count: 10 }))[0].value).toBe("4.6/5");
    expect(siteStatItems(envelope({ average_rating: 5, rating_count: 10 }))[0].value).toBe("5.0/5");
  });

  it("is empty for missing or malformed payloads", () => {
    for (const payload of [null, undefined, "x", {}, { data: { stats: [] } }, envelope(null)]) expect(siteStatItems(payload)).toEqual([]);
  });
});

describe("count-up values", () => {
  it("end exactly on the honest text and never pass the shown number", () => {
    const [students, , , , , rating] = siteStatValues(siteStatItems(envelope(FULL)));
    expect(students.value.props.value).toBe(130);
    expect(students.value.props.format(130)).toBe("130+");
    expect(students.value.props.format(64.7)).toBe("64+");
    expect(rating.value).toBe("4.6/5");
    expect(rating.note).toBe("from 23 reviews");
  });
});

describe("fetch and strips", () => {
  it("shares one request and degrades to no items on failure", async () => {
    api.get.mockResolvedValueOnce({ data: envelope(FULL) });
    const first = await fetchSiteStats();
    const second = await fetchSiteStats();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("/site/stats/");
    expect(first.status).toBe("ready");
    expect(second.items).toHaveLength(6);

    resetSiteStatsCache();
    api.get.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchSiteStats()).toEqual({ status: "unavailable", items: [] });
  });

  it("renders nothing when the API fails or nothing reaches its minimum", async () => {
    api.get.mockRejectedValueOnce(new Error("offline"));
    const tree = await renderTree(<SiteStatStrip label="About us in numbers" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(tree.container.children).toHaveLength(0);
    await tree.unmount();
    expect(renderToStaticMarkup(<SiteStatStrip items={[]} />)).toBe("");
  });

  it("renders the live figures in the strip once loaded", async () => {
    api.get.mockResolvedValueOnce({ data: envelope(FULL) });
    const tree = await renderTree(<SiteStatStrip label="About us in numbers" />);
    await act(async () => {
      await Promise.resolve();
    });
    const text = tree.text();
    expect(text).toContain("Students enrolled");
    expect(text).toContain("4.6/5");
    await tree.unmount();
  });

  // Hybrid release: /about is the Friday 13 Nov page again (owner decision),
  // with its own copy; the strip rule applies to the 13ca6b79 marketing pages.
});
