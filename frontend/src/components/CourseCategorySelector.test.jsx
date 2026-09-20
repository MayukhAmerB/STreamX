import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CourseCategorySelector, { CourseTrackCards } from "./CourseCategorySelector";
import { getCourseCategoryPath } from "../utils/courseCatalog";

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe("CourseCategorySelector", () => {
  it("renders the two professional tracks with their supplied artwork and course totals", () => {
    const html = renderToStaticMarkup(
      <CourseCategorySelector
        selectedCategory="osint"
        counts={{ osint: 4, web_pentesting: 3 }}
      />
    );

    expect(html).toContain("Choose your training path");
    expect(html).toContain("OSINT");
    expect(html).toContain("Pentesting");
    expect(html).toContain("Open Source Intelligence");
    expect(html).toContain("Web Application &amp; API Security");
    expect(html).toContain("4 courses");
    expect(html).toContain("3 courses");
    expect(html).toContain("course-track-osint.png");
    expect(html).toContain("course-track-pentesting.png");
    expect(html).toContain('aria-pressed="true"');
  });

  it("reuses the same logo cards as compact mobile links on the landing page", () => {
    const html = renderToStaticMarkup(
      <CourseTrackCards
        counts={{ osint: 2, web_pentesting: 1 }}
        getHref={getCourseCategoryPath}
        compactMobile
      />
    );

    expect(html).toContain('href="/courses?category=osint#course-category-results"');
    expect(html).toContain('href="/courses?category=web_pentesting#course-category-results"');
    expect(html).toContain("course-track-osint.png");
    expect(html).toContain("course-track-pentesting.png");
    expect(html).toContain("min-w-[72%]");
    expect(html).toContain("min-h-[310px]");
    expect(html).toContain("sm:min-h-[420px]");
  });

  it("keeps the full-size mobile cards for the course catalog", () => {
    const html = renderToStaticMarkup(
      <CourseTrackCards counts={{ osint: 2, web_pentesting: 1 }} />
    );

    expect(html).toContain("min-w-[82%]");
    expect(html).toContain("min-h-[390px]");
    expect(html).not.toContain("min-w-[72%]");
  });

  it("uses the same one-click category links in the full course selector", () => {
    const html = renderToStaticMarkup(
      <CourseCategorySelector
        selectedCategory="osint"
        counts={{ osint: 1, web_pentesting: 1 }}
        getHref={getCourseCategoryPath}
      />
    );

    expect(html).toContain('href="/courses?category=osint#course-category-results"');
    expect(html).toContain(
      'href="/courses?category=web_pentesting#course-category-results"'
    );
  });
});
