import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import OwnedCourseCard from "./OwnedCourseCard";

describe("OwnedCourseCard", () => {
  it("renders learning progress, admin-managed facts, benefits, and all student actions", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/my-courses">
        <OwnedCourseCard
          course={{
            id: 29,
            title: "OSINT Professional Training Program",
            card_summary: "Investigate, verify, and report with a professional workflow.",
            category: "osint",
            level: "advanced",
            access_label: "Purchased",
            enrolled_at: "2026-09-01T10:30:00Z",
            section_count: 5,
            lecture_count: 20,
            started_lecture_count: 8,
            completed_lecture_count: 6,
            progress_percent: 30,
            batch: "Batch IV",
            duration: "3 months",
            schedule: "Friday to Sunday",
            total_classes: 36,
            instructor: { full_name: "Al Syed Faculty" },
            course_card_features: [
              { title: "Live instructor-led classes" },
              { title: "Lifetime recorded access" },
            ],
          }}
        />
      </StaticRouter>,
    );

    expect(html).toContain("6 of 20 lessons completed");
    expect(html).toContain('aria-valuenow="30"');
    expect(html).toContain("Batch IV");
    expect(html).toContain("3 months");
    expect(html).toContain("Friday to Sunday");
    expect(html).toContain("36 classes");
    expect(html).toContain("Live instructor-led classes");
    expect(html).toContain("Al Syed Faculty");
    expect(html).toContain('href="/learn/29"');
    expect(html).toContain('href="/courses/29/live"');
    expect(html).toContain('href="/courses/29"');
  });
});
