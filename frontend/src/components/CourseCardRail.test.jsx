import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import CourseCardRail, { COURSE_RAIL_DESKTOP_VISIBLE } from "./CourseCardRail";

describe("CourseCardRail", () => {
  it("renders a four-card desktop rail with scrolling controls", () => {
    const courses = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      title: `Course ${index + 1}`,
      category: "osint",
      launch_status: "live",
    }));
    const html = renderToStaticMarkup(
      <StaticRouter location="/">
        <CourseCardRail courses={courses} />
      </StaticRouter>,
    );

    expect(COURSE_RAIL_DESKTOP_VISIBLE).toBe(4);
    expect(html).toContain('data-desktop-visible="4"');
    expect(html).toContain("lg:auto-cols-[calc((100%_-_2.25rem)/4)]");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("Scroll courses backward");
    expect(html).toContain("Scroll courses forward");
    expect((html.match(/See Details/g) || []).length).toBe(6);
  });
});
