import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import {
  CourseCatalogContent,
  getCourseCatalogSummary,
  getCourseLevelSummary,
  getTrackEmptyState,
  resolveCourseCategory,
} from "./CourseListPage";

function renderCatalog(courses) {
  return renderToStaticMarkup(
    <StaticRouter location="/courses">
      <CourseCatalogContent
        courses={courses}
        loading={false}
        error=""
        search=""
        setSearch={() => {}}
        summary={getCourseCatalogSummary(courses)}
        levelSummary={getCourseLevelSummary(courses)}
      />
    </StaticRouter>
  );
}

describe("CourseListPage catalog rendering", () => {
  it("opens directly on OSINT while honoring a hero-selected Pentesting section", () => {
    expect(resolveCourseCategory("")).toBe("osint");
    expect(resolveCourseCategory("invalid")).toBe("osint");
    expect(resolveCourseCategory("web_pentesting")).toBe("web_pentesting");
  });

  it("keeps authenticated catalog cards details-first without prices or direct actions", () => {
    const html = renderCatalog([
      {
        id: 11,
        title: "OSINT Professional Training Program",
        description: "Structured OSINT training track.",
        price: 3500,
        category: "osint",
        level: "advanced",
        launch_status: "live",
        section_count: 4,
        instructor: { full_name: "Instructor" },
        is_enrolled: true,
        enrollment_status: "approved",
      },
      {
        id: 12,
        title: "Web Application Pentesting Beginner",
        description: "Coming soon beginner web application testing track.",
        price: 2000,
        category: "web_pentesting",
        level: "beginner",
        launch_status: "live",
        section_count: 2,
        instructor: { full_name: "Instructor" },
        is_enrolled: false,
        enrollment_status: "none",
      },
    ]);

    expect(html).toContain("See Details");
    expect(html).toContain('href="/courses/11"');
    expect(html).toContain('href="/courses/12"');
    expect(html).not.toContain('href="/learn/11"');
    expect(html).not.toContain('href="/courses/12/register"');
    expect(html).not.toContain("3,500");
    expect(html).not.toContain("2,000");
    expect(html).toContain("Live");
  });

  it("keeps pending and coming-soon catalog items available for details", () => {
    const html = renderCatalog([
      {
        id: 21,
        title: "Pending Access Course",
        description: "Pending enrollment should not unlock the course action.",
        price: 3000,
        category: "osint",
        level: "intermediate",
        launch_status: "live",
        section_count: 3,
        instructor: { full_name: "Instructor" },
        is_enrolled: false,
        enrollment_status: "pending",
      },
      {
        id: 22,
        title: "Upcoming Course",
        description: "Coming soon courses should stay locked.",
        price: 3200,
        category: "web_pentesting",
        level: "advanced",
        launch_status: "coming_soon",
        section_count: 1,
        instructor: { full_name: "Instructor" },
        is_enrolled: true,
        enrollment_status: "approved",
      },
    ]);

    expect(html).not.toContain('href="/learn/21"');
    expect(html).not.toContain('href="/learn/22"');
    expect(html).toContain('href="/courses/21"');
    expect(html).toContain('href="/courses/22"');
    expect(html).toContain("See Details");
    expect(html).toContain("Coming Soon");
  });
});

describe("empty track (plan §7.2 rule 3)", () => {
  const tracks = [
    { key: "osint", title: "Open Source Intelligence", state: "open", courseCount: 2, openCourseCount: 2 },
    { key: "web_pentesting", title: "Web Application & API Security", state: "coming_soon", courseCount: 0, openCourseCount: 0 },
  ];
  const render = (emptyState, search = "") =>
    renderToStaticMarkup(
      <StaticRouter location="/courses?category=web_pentesting">
        <CourseCatalogContent courses={[]} loading={false} error="" search={search} setSearch={() => {}} emptyState={emptyState} />
      </StaticRouter>
    );

  it("shows one calm empty state for a track that is not open, pointing at the open track", () => {
    const markup = render(getTrackEmptyState(tracks, "web_pentesting"));
    expect(markup).toContain("Pentesting opens soon");
    expect(markup).toContain("Coming soon · No courses yet.");
    expect(markup).toContain('href="/courses?category=osint#course-category-results"');
    expect(markup).not.toContain("No courses are available right now.");
  });

  it("has no empty state for an open or unknown track, and searching still says No courses found", () => {
    expect(getTrackEmptyState(tracks, "osint")).toBeNull();
    expect(getTrackEmptyState([], "web_pentesting")).toBeNull();
    expect(render(getTrackEmptyState(tracks, "web_pentesting"), "zzz")).toContain("No courses found.");
  });

  it("falls back to Contact when no track is open", () => {
    const closed = tracks.map((track) => ({ ...track, state: "coming_soon" }));
    expect(render(getTrackEmptyState(closed, "web_pentesting"))).toContain('href="/contact"');
  });
});
