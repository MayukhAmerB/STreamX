import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import {
  CourseCatalogContent,
  getCourseCatalogSummary,
  getCourseLevelSummary,
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
