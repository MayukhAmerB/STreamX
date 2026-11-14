import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";
import { MembershipIncludedSection } from "./MembershipIncluded";
import { buildMembershipLibrary, formatBundleMonth } from "./membershipLibrary";

const NOW = Date.parse("2026-11-15T06:00:00Z");
const catalog = {
  plans: [
    { key: "free", product: "free" },
    { key: "ctf_starter_monthly", product: "ctf_starter", starter_course: { id: 7, title: "OSINT Batch IV" } },
    { key: "ctf_starter_batch5", product: "ctf_starter", starter_course: { id: 8, title: "OSINT Batch V" } },
    {
      key: "ctf_labs_monthly",
      product: "ctf_labs",
      included_this_month: { month: "2026-11", courses: [{ id: 3, title: "Geolocation" }, { id: 7, title: "OSINT Batch IV" }] },
    },
  ],
};
const sub = (planKey, entitlements, overrides = {}) => ({
  id: 1,
  plan_key: planKey,
  status: "active",
  access_until: "2026-12-01T00:00:00Z",
  entitlements,
  ...overrides,
});

describe("buildMembershipLibrary", () => {
  it("is inactive without a plan (the common case today)", () => {
    expect(buildMembershipLibrary({ catalog, now: NOW })).toMatchObject({ active: false, courses: [] });
    expect(buildMembershipLibrary()).toMatchObject({ active: false });
  });

  it("CTF Labs membership: this month's bundle, labelled Included this month", () => {
    const lib = buildMembershipLibrary({ entitlement: { ctf_labs: { active: true } }, catalog, now: NOW });
    expect(lib).toMatchObject({ active: true, labsActive: true, monthLabel: "November 2026" });
    expect(lib.courses.map((c) => [c.id, c.label])).toEqual([
      [3, "Included this month"],
      [7, "Included this month"],
    ]);
  });

  it("Starter: only the batch of the viewer's own Starter plan", () => {
    const lib = buildMembershipLibrary({ subscriptions: { subscriptions: [sub("ctf_starter_monthly", ["ctf_starter"])] }, catalog, now: NOW });
    expect(lib.starterActive).toBe(true);
    expect(lib.courses).toEqual([{ id: 7, title: "OSINT Batch IV", source: "starter", label: "Included with Starter" }]);
  });

  it("drops expired subscriptions and courses the viewer is enrolled in", () => {
    const expired = sub("ctf_labs_monthly", ["ctf_labs"], { access_until: "2026-11-01T00:00:00Z", status: "cancelled" });
    expect(buildMembershipLibrary({ subscriptions: { subscriptions: [expired] }, catalog, now: NOW }).active).toBe(false);
    const lib = buildMembershipLibrary({ entitlement: { ctf_labs: { active: true } }, catalog, ownedIds: [3], now: NOW });
    expect(lib.courses.map((c) => c.id)).toEqual([7]);
  });

  it("formats the bundle month and ignores junk", () => {
    expect(formatBundleMonth("2026-01")).toBe("January 2026");
    expect(formatBundleMonth("soon")).toBe("");
  });
});

describe("MembershipIncludedSection", () => {
  const render = (library) =>
    renderToStaticMarkup(
      <StaticRouter location="/my-courses">
        <MembershipIncludedSection library={library} />
      </StaticRouter>
    );

  it("renders nothing without an active plan", () => {
    expect(render(null)).toBe("");
    expect(render({ active: false, courses: [] })).toBe("");
  });

  it("lists included recordings with a visible word label (no colour-only state)", () => {
    const html = render(buildMembershipLibrary({ entitlement: { ctf_labs: { active: true } }, catalog, now: NOW }));
    expect(html).toContain("Included this month · November 2026");
    expect(html).toContain('href="/learn/3"');
    expect((html.match(/mc-included__chip/g) || []).length).toBe(2);
    expect(html).toContain("Live classes, reports, exams and certificates stay with");
  });

  it("explains an empty bundle calmly", () => {
    expect(render({ active: true, labsActive: true, monthLabel: "", courses: [] })).toContain("being chosen");
  });
});
