import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ data: null }));
vi.mock("../marketing/useMarketingData", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useMarketingData: () => state.data };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true }) }));

import { normalizeCatalog } from "../marketing/catalogApi";
import { catalogStats, tiersFromData } from "../marketing/useMarketingData";
import CourseListPage, { getCourseCatalogSummary, getCourseLevelSummary, getTrackEmptyState, resolveCourseCategory } from "./CourseListPage";

const CLOSED = { enabled: false, reason: "Pentesting is coming soon.", known: true };

function dataFor(courses, tracks = []) {
  const catalog = normalizeCatalog({});
  return {
    courses: { courses, tracks, status: "ready", retry: () => {} },
    catalog,
    gate: CLOSED,
    tiers: tiersFromData(courses, []),
    osint: courses.filter((course) => course.category === "osint"),
    stats: catalogStats(courses),
    tierCount: 5,
  };
}

const render = (location = "/courses") =>
  renderToStaticMarkup(
    <StaticRouter location={location}>
      <CourseListPage />
    </StaticRouter>,
  );

beforeEach(() => {
  state.data = dataFor([]);
});

describe("CourseListPage catalog rendering", () => {
  it("opens directly on OSINT while honoring a hero-selected Pentesting section", () => {
    expect(resolveCourseCategory("")).toBe("osint");
    expect(resolveCourseCategory("invalid")).toBe("osint");
    expect(resolveCourseCategory("web_pentesting")).toBe("web_pentesting");
  });

  it("keeps authenticated catalog cards details-first without prices or direct actions", () => {
    state.data = dataFor([
      { id: 11, title: "OSINT Professional Training Program", description: "Structured OSINT training track.", price: 3500, category: "osint", level: "advanced", launch_status: "live", section_count: 4, is_enrolled: true, enrollment_status: "approved" },
      { id: 12, title: "Web Application Pentesting Beginner", description: "Beginner web application testing track.", price: 2000, category: "web_pentesting", tier: "offensive", level: "beginner", launch_status: "live", section_count: 2, is_enrolled: false, enrollment_status: "none" },
    ]);
    const html = render();
    expect(html).toContain('href="/courses/11"');
    expect(html).toContain('href="/courses/12"');
    expect(html).not.toContain('href="/learn/11"');
    expect(html).not.toContain('href="/courses/12/register"');
    expect(html).not.toContain("3,500");
    expect(html).not.toContain("2,000");
    expect(html).toContain("View course");
    expect(html).toContain('data-status="open"');
  });

  it("keeps pending and coming-soon catalog items available for details (Pentesting browsable while closed)", () => {
    state.data = dataFor([
      { id: 21, title: "Pending Access Course", category: "osint", level: "intermediate", launch_status: "live", section_count: 3, enrollment_status: "pending" },
      { id: 22, title: "Upcoming Course", category: "web_pentesting", tier: "foundations", level: "advanced", launch_status: "coming_soon", section_count: 1, is_enrolled: true },
    ]);
    const html = render();
    expect(html).not.toContain('href="/learn/21"');
    expect(html).not.toContain('href="/learn/22"');
    expect(html).toContain('href="/courses/21"');
    expect(html).toContain('href="/courses/22"');
    expect(html).toContain("Coming soon");
    expect(html).toContain("Browse outline");
    expect(html).toContain("Pentesting is coming soon");
  });

  it("filters by tier and category from the URL, with chips that keep ?view=live and ?category=", () => {
    state.data = dataFor([
      { id: 31, title: "OSINT cohort", category: "osint", launch_status: "live" },
      { id: 32, title: "Shell basics", category: "web_pentesting", tier: "foundations", launch_status: "coming_soon" },
      { id: 33, title: "Phishing check", category: "web_pentesting", tier: "quick_wins", launch_status: "coming_soon" },
    ]);
    const tier = render("/courses?tier=quick_wins");
    expect(tier).toContain('href="/courses/33"');
    expect(tier).not.toContain('href="/courses/32"');
    expect(tier).not.toContain('href="/courses/31"');
    expect(tier).toContain('aria-current="page"');
    const all = render();
    expect(all).toContain('href="/courses?view=live#course-category-results"');
    expect(all).toContain('href="/courses?category=osint#course-category-results"');
    expect(all).toContain('href="https://labs.alsyedinitiative.com/#hub"');
    expect(render("/courses?category=osint")).not.toContain('href="/courses/32"');
  });

  it("counts the catalogue for the stat strip", () => {
    const courses = [{ category: "osint", launch_status: "live", level: "beginner" }, { category: "web_pentesting", launch_status: "coming_soon", level: "advanced" }];
    expect(getCourseCatalogSummary(courses)).toEqual({ live: 1, comingSoon: 1, osint: 1, web: 1 });
    expect(getCourseLevelSummary(courses)).toMatchObject({ beginner: 1, advanced: 1 });
  });
});

describe("empty track (plan §7.2 rule 3)", () => {
  const tracks = [
    { key: "osint", title: "Open Source Intelligence", state: "open", courseCount: 2, openCourseCount: 2 },
    { key: "web_pentesting", title: "Web Application & API Security", state: "coming_soon", courseCount: 0, openCourseCount: 0 },
  ];
  const renderEmpty = (element) => renderToStaticMarkup(<StaticRouter location="/courses?category=web_pentesting">{element}</StaticRouter>);

  it("shows one calm empty state for a track that is not open, pointing at the open track", () => {
    const markup = renderEmpty(getTrackEmptyState(tracks, "web_pentesting"));
    expect(markup).toContain("Pentesting opens soon");
    expect(markup).toContain("Coming soon · No courses yet.");
    expect(markup).toContain('href="/courses?category=osint#course-category-results"');
    state.data = dataFor([], tracks);
    const page = render("/courses?category=web_pentesting");
    expect(page).toContain("Pentesting opens soon");
    expect(page).not.toContain("No courses are available right now.");
  });

  it("has no empty state for an open or unknown track", () => {
    expect(getTrackEmptyState(tracks, "osint")).toBeNull();
    expect(getTrackEmptyState([], "web_pentesting")).toBeNull();
  });

  it("falls back to Contact when no track is open", () => {
    const closed = tracks.map((track) => ({ ...track, state: "coming_soon" }));
    expect(renderEmpty(getTrackEmptyState(closed, "web_pentesting"))).toContain('href="/contact"');
  });
});
