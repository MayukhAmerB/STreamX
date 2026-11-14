import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: null, auth: { isAuthenticated: false } }));

vi.mock("./useMarketingData", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketingData: () => state.data };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => state.auth }));

import { EXAM_LAB, FREE_TIER, labAccess, LABS, labUrl } from "../data/freeLabs";
import { landingVariant } from "../pages/landing/landingFlag";
import { Calligraphy, HERO_REFERENCE, HERO_TRANSLATION, LandingHero, TrackPair } from "../pages/landing/LandingPageHP";
import BootcampPage from "../pages/BootcampPage";
import { resolveCatalogFilter } from "../pages/CourseListPage";
import PricingPage, { ComparisonTable } from "../pages/PricingPage";
import { CourseActions } from "../pages/ProfessionalCoursePage";
import RoadmapPage from "../pages/RoadmapPage";
import TrackPage from "../pages/TrackPage";
import { coursePurchaseGate, normalizeCatalog, normalizeDirectory, pentestingGate } from "./catalogApi";
import { catalogStats, tiersFromData } from "./useMarketingData";
import { DirectoryRow, startLabel } from "./pages/FreeDirectoryPage";
import { PricingCard } from "./Pricing";
import { mergePlans, OSINT_PLANS, PENTESTING_PLANS, PENTESTING_REASON, planPriceLabel, PRICE_AT_LAUNCH } from "./plans";

const html = (element, location = "/") => renderToStaticMarkup(<StaticRouter location={location}>{element}</StaticRouter>);
const track = (slug) =>
  html(
    <Routes>
      <Route path="/tracks/:track" element={<TrackPage />} />
    </Routes>,
    `/tracks/${slug}`,
  );

const PT = (id, tier, extra = {}) => ({
  id,
  title: `Pentesting course ${id}`,
  category: "web_pentesting",
  tier,
  tier_order: id,
  module_count: 6,
  launch_status: "coming_soon",
  registration_closed: true,
  is_published: true,
  ...extra,
});
const OSINT = { id: 7, title: "OSINT Professional Program", category: "osint", launch_status: "live", is_published: true, module_count: 8 };
const COURSES = [OSINT, PT(41, "foundations"), PT(42, "foundations"), PT(51, "offensive"), PT(61, "quick_wins")];
const CLOSED = { enabled: false, reason: "Pentesting is coming soon. You can browse every course now; enrolment opens at launch.", known: true };

function makeData({ gate = CLOSED, plans = [], catalogExtra = {} } = {}) {
  const catalog = { ...normalizeCatalog({ plans, gates: { pentesting: gate } }), ...catalogExtra };
  return {
    courses: { courses: COURSES, tracks: [], status: "ready", retry: () => {} },
    catalog,
    gate,
    tiers: tiersFromData(COURSES, catalog.tiers),
    osint: [OSINT],
    stats: catalogStats(COURSES, catalog.stats),
    tierCount: 5,
  };
}

beforeEach(() => {
  state.data = makeData();
  state.auth = { isAuthenticated: false };
});

describe("landing (HackPath philosophy)", () => {
  it("serves the new page by default and keeps both rollbacks", () => {
    expect(landingVariant(undefined)).toBe("hp");
    expect(landingVariant("on")).toBe("hp");
    expect(landingVariant("v2")).toBe("v2");
    expect(landingVariant("off")).toBe("v1");
  });

  it("renders the calligraphy (wide + stacked), the translation, the attribution and one handwritten word in the h1", () => {
    const markup = html(<LandingHero isAuthenticated={false} liveBroadcast={null} stats={catalogStats(COURSES)} />);
    expect(markup).toContain('media="(max-width: 640px)"');
    expect(markup).toMatch(/<img[^>]+width="1500" height="500"[^>]+fetchpriority="high"/);
    expect(markup).toContain("Qur&#x27;an 20:114 in golden Arabic calligraphy");
    expect(markup).toContain(HERO_TRANSLATION);
    expect(markup).toContain(HERO_REFERENCE.replace("'", "&#x27;"));
    const h1 = markup.match(/<h1[^>]*>.*?<\/h1>/)[0];
    expect(h1.match(/class="hp-hand[ "]/g)).toHaveLength(1);
    expect(markup).toContain(`href="${FREE_TIER.href}"`);
    expect(markup).toContain('href="/courses"');
  });

  it("keeps a same-ratio slot when the artwork is missing (no CLS)", () => {
    const markup = html(<Calligraphy wide="" />);
    expect(markup).toContain("hp-calligraphy__slot");
    expect(markup).toContain('role="img"');
  });

  it("lists both tracks; Pentesting is browsable and says Coming soon while the switch is off", () => {
    const markup = html(<TrackPair gate={CLOSED} />);
    expect(markup).toContain('aria-label="Professional tracks"');
    expect(markup).toContain('data-track="web_pentesting" data-state="coming_soon"');
    expect(markup).toContain('href="/tracks/pentesting"');
    expect(markup).toContain("Coming soon");
    expect(html(<TrackPair gate={{ enabled: true, reason: "" }} />)).toContain('data-track="web_pentesting" data-state="open"');
  });
});

describe("plans and gates", () => {
  it("never shows an unconfirmed price and only opens a plan the server marks available", () => {
    const merged = mergePlans(OSINT_PLANS, [
      { key: "ctf_labs_monthly", product: "ctf_labs", group: "osint", price: null, state: "coming_soon", reason: "Monthly memberships are not open yet." },
      { key: "ctf_starter_monthly", product: "ctf_starter", group: "osint", price: "500.00", state: "coming_soon", reason: "Not yet" },
    ]);
    const labs = merged.find((plan) => plan.key === "ctf_labs");
    const starter = merged.find((plan) => plan.key === "starter");
    expect(planPriceLabel(labs)).toBeNull();
    expect(planPriceLabel(starter)).toBe("₹500");
    expect(labs.state).toBe("coming_soon");
    expect(planPriceLabel(merged.find((plan) => plan.key === "free"))).toBe("₹0");
    // Unknown server state never becomes "available".
    expect(mergePlans(OSINT_PLANS, [{ key: "ctf_labs_monthly", product: "ctf_labs", state: "weird" }]).find((plan) => plan.key === "ctf_labs").state).toBe("coming_soon");
  });

  it("renders one highlighted plan, Price at launch, the Free path and disabled paid CTAs with a reason", () => {
    const markup = html(
      <>
        {OSINT_PLANS.map((plan) => (
          <PricingCard key={plan.key} plan={plan} />
        ))}
      </>,
    );
    expect(markup.match(/hp-plan--highlighted/g)).toHaveLength(1);
    expect(markup).toContain(PRICE_AT_LAUNCH);
    expect(markup).toContain(`href="${FREE_TIER.href}"`);
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(markup).toContain("Opens once the price is confirmed");
    expect(markup).not.toMatch(/href="\/pricing\?plan=/);
  });

  it("disables every Pentesting plan with the switch reason", () => {
    const markup = html(
      <>
        {PENTESTING_PLANS.map((plan) => (
          <PricingCard key={plan.key} plan={plan} />
        ))}
      </>,
    );
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(PENTESTING_PLANS.length);
    expect(markup).toContain(PENTESTING_REASON);
  });

  it("closes Pentesting when the gate is off or unknown, and opens it only on the server's word", () => {
    expect(pentestingGate({ gates: { pentesting: { enabled: false, reason: "R" } } }, [])).toMatchObject({ enabled: false, reason: "R" });
    expect(pentestingGate({ gates: {} }, [])).toMatchObject({ enabled: false });
    expect(pentestingGate({ gates: { pentesting: { enabled: true } } }, [])).toMatchObject({ enabled: true });
    const course = { category: "web_pentesting", purchase_gate: { state: "available" } };
    expect(coursePurchaseGate(course, CLOSED)).toMatchObject({ disabled: true, code: "feature_disabled" });
    expect(coursePurchaseGate(course, { enabled: true })).toMatchObject({ disabled: false });
    expect(coursePurchaseGate({ category: "osint" }, null)).toMatchObject({ disabled: false });
    expect(coursePurchaseGate({ category: "osint", purchase_gate: { state: "unavailable", reason: "Closed" } }, null)).toMatchObject({ disabled: true, reason: "Closed" });
  });

  it("compares the OSINT plans with sr-only words for every mark", () => {
    const markup = html(<ComparisonTable plans={OSINT_PLANS} />);
    expect(markup).toContain("Included");
    expect(markup).toContain("Not included");
    expect(markup).toContain("is-recommended");
  });

  it("renders the pricing page: Free, Starter, the membership and the Pentesting plans", () => {
    const markup = html(<PricingPage />, "/pricing");
    for (const text of ["Free", "Starter", "CTF Labs membership", "Bootcamp", "Pentesting membership", "Lifetime", "Monthly", "Yearly"]) {
      expect(markup).toContain(text);
    }
    expect(markup.match(/hp-plan--highlighted/g)).toHaveLength(1);
  });
});

describe("Pentesting: browsable, never purchasable while the switch is off", () => {
  it("lists every tier and course on the track page with a disabled Enrol and its reason", () => {
    const markup = track("pentesting");
    expect(markup).toContain("Foundations");
    expect(markup).toContain("Offensive security");
    expect(markup).toContain("Quick wins");
    for (const id of [41, 42, 51, 61]) expect(markup).toContain(`href="/courses/${id}"`);
    expect(markup).toMatch(/role="button" aria-disabled="true" tabindex="0" aria-describedby="[^"]+"/);
    expect(markup).toContain(CLOSED.reason);
    expect(markup).not.toMatch(/\/register"|\/payment"/);
  });

  it("drops the disabled control once the switch is on", () => {
    state.data = makeData({ gate: { enabled: true, reason: "" } });
    const markup = track("pentesting");
    expect(markup).not.toContain("Enrol (coming soon)");
    expect(markup).toContain('href="/pricing#pentesting"');
  });

  it("disables Apply on a Pentesting course page and never links to register or payment", () => {
    const course = { category: "web_pentesting", launch_status: "live", registration_closed: false };
    const gate = coursePurchaseGate(course, CLOSED);
    const markup = html(<CourseActions course={course} id="41" gate={gate} />);
    expect(markup).toContain("Apply (coming soon)");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain(CLOSED.reason);
    expect(markup).not.toContain('href="/courses/41/register"');
    const open = html(<CourseActions course={course} id="41" gate={coursePurchaseGate(course, { enabled: true })} />);
    expect(open).toContain('href="/courses/41/register"');
  });

  it("keeps the enrolled student's Continue learning and installment links", () => {
    const course = { category: "web_pentesting", is_enrolled: true, enrollment_access_type: "installment" };
    const markup = html(<CourseActions course={course} id="9" gate={coursePurchaseGate(course, CLOSED)} />);
    expect(markup).toContain('href="/learn/9"');
    expect(markup).toContain('href="/courses/9/payment"');
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("disables Start bootcamp with the reason and shows no price before it is confirmed", () => {
    const markup = html(<BootcampPage />, "/bootcamp");
    expect(markup).toContain("Start bootcamp (coming soon)");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("At launch");
    expect(markup).toContain('href="/courses/41"');
  });
});

describe("OSINT track, free tier and roadmap", () => {
  it("deep-links each lab tab and never presents the exam (tab 05) as free", () => {
    expect(LABS.map((lab) => labUrl(lab.tab))).toEqual([
      "https://labs.alsyedinitiative.com/#hub",
      "https://labs.alsyedinitiative.com/#realworld",
      "https://labs.alsyedinitiative.com/#blackmeridian",
      "https://labs.alsyedinitiative.com/#certification",
    ]);
    expect(LABS.some((lab) => lab.tab === EXAM_LAB.tab)).toBe(false);
    expect(labAccess(LABS[1], { membershipRequired: true }).kind).toBe("members");
    expect(labAccess(LABS[1]).kind).toBe("open");
    const markup = track("osint");
    expect(markup).toContain('href="https://labs.alsyedinitiative.com/#realworld"');
    expect(markup).toContain(`href="${FREE_TIER.href}"`);
    expect(markup).toContain('href="/courses/7"');
  });

  it("links out to the platform for free challenges and only lets signed-in users mark them done", () => {
    const item = { id: 3, title: "Street corner", platform: "Example CTF", url: "https://example.org/c/1", difficulty: "easy", estimated_minutes: 45, xp: 20 };
    expect(startLabel(item)).toBe("Start on Example CTF");
    const guest = html(<ul><DirectoryRow item={item} done={false} canTrack={false} onToggle={() => {}} /></ul>);
    expect(guest).toContain('href="https://example.org/c/1"');
    expect(guest).toContain('rel="noopener noreferrer"');
    expect(guest).not.toContain("Mark done");
    expect(html(<ul><DirectoryRow item={item} done canTrack onToggle={() => {}} /></ul>)).toContain('aria-pressed="true"');
    expect(normalizeDirectory({ success: true, data: { items: [item, { id: 4, title: "Bad", url: "javascript:alert(1)" }] } }).items).toHaveLength(1);
  });

  it("renders the roadmap as a tablist with status words, never colour dots", () => {
    const markup = html(<RoadmapPage />, "/roadmap");
    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(4);
    expect(markup).toContain("Available now");
    expect(markup).toContain("Coming soon");
    expect(markup).toContain('data-status="open"');
  });

  it("maps catalogue filters from the URL, keeping ?view=live and ?category=", () => {
    const params = (query) => new URLSearchParams(query);
    expect(resolveCatalogFilter(params(""))).toBe("all");
    expect(resolveCatalogFilter(params("view=live"))).toBe("live");
    expect(resolveCatalogFilter(params("category=osint"))).toBe("osint");
    expect(resolveCatalogFilter(params("category=web_pentesting"))).toBe("web_pentesting");
    expect(resolveCatalogFilter(params("tier=quick_wins"))).toBe("quick_wins");
    expect(resolveCatalogFilter(params("tier=nope"))).toBe("all");
    expect(resolveCatalogFilter(params("filter=free"))).toBe("free");
  });
});
