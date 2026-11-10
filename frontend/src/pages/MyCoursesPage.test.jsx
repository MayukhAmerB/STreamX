import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { filterCourses, getStudentLibraryStats, MyCoursesView, SEARCH_THRESHOLD } from "./MyCoursesPage";

const course = (overrides = {}) => ({
  id: 29,
  title: "OSINT Professional Training Program",
  category: "osint",
  lecture_count: 20,
  started_lecture_count: 8,
  completed_lecture_count: 6,
  progress_percent: 30,
  ...overrides,
});

function render(props) {
  return renderToStaticMarkup(
    <StaticRouter location="/my-courses">
      <MyCoursesView {...props} />
    </StaticRouter>
  );
}

describe("getStudentLibraryStats", () => {
  it("summarizes ready, active, and completed courses", () => {
    expect(
      getStudentLibraryStats([
        { id: 1, progress_percent: 0 },
        { id: 2, progress_percent: 45 },
        { id: 3, progress_percent: 100 },
      ]),
    ).toEqual({ total: 3, inProgress: 1, completed: 1 });
  });

  it("handles an invalid response safely", () => {
    expect(getStudentLibraryStats(null)).toEqual({ total: 0, inProgress: 0, completed: 0 });
  });
});

describe("filterCourses", () => {
  it("matches titles case-insensitively and ignores blank queries", () => {
    const list = [course({ id: 1, title: "OSINT Basics" }), course({ id: 2, title: "Web Pentesting" })];
    expect(filterCourses(list, "  osint ").map((item) => item.id)).toEqual([1]);
    expect(filterCourses(list, "")).toBe(list);
  });
});

describe("MyCoursesView", () => {
  it("renders a course tile with progress and one clear primary action", () => {
    const html = render({ courses: [course()] });
    expect(html).toContain("My courses");
    expect(html).toContain("OSINT Professional Training Program");
    expect(html).toContain("30% complete");
    expect(html).toContain("6 of 20 lessons done");
    expect(html).toContain('href="/learn/29"');
    expect(html).toContain(">Continue<");
    expect(html).toContain('href="/courses/29/live"');
    expect(html).toContain('href="/courses/29"');
    // OSINT owners get the tools shortcut.
    expect(html).toContain('href="/osint-tools"');
    // Short lists do not need a search box.
    expect(html).not.toContain("Search your courses");
  });

  it("shows search once the list is long", () => {
    const courses = Array.from({ length: SEARCH_THRESHOLD }, (_, index) => course({ id: index + 1 }));
    expect(render({ courses })).toContain("Search your courses");
  });

  it("shows an empty state with a single action", () => {
    const html = render({ courses: [] });
    expect(html).toContain("Your purchased or approved courses will appear here.");
    expect(html).toContain('href="/courses"');
  });

  it("shows an error with a retry action", () => {
    const html = render({ courses: [], error: "Network down", onRetry: () => {} });
    expect(html).toContain("Couldn&#x27;t load your courses.");
    expect(html).toContain("Network down");
    expect(html).toContain("Try again");
  });

  it("shows a skeleton while loading", () => {
    const html = render({ loading: true });
    expect(html).toContain("cds--skeleton");
    expect(html).toContain("Loading your courses");
  });
});
