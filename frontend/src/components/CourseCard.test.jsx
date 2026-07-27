import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import CourseCard from "./CourseCard";

function renderCourseCard(props) {
  return renderToStaticMarkup(
    <StaticRouter location="/courses">
      <CourseCard {...props} />
    </StaticRouter>
  );
}

describe("CourseCard", () => {
  const baseCourse = {
    id: 11,
    title: "OSINT Professional Training Program",
    description: "Structured OSINT training track.",
    price: 3500,
    category: "osint",
    level: "advanced",
    launch_status: "live",
    section_count: 4,
    instructor: { full_name: "Instructor" },
  };

  it("renders a Go to Course action for accessible live courses", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: true,
        enrollment_status: "approved",
      },
    });

    expect(html).toContain("Go to Course");
    expect(html).toContain('href="/learn/11"');
  });

  it("keeps the standard live action when the user does not have access", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: false,
        enrollment_status: "none",
        purchase_available: true,
      },
    });

    expect(html).toContain("Live");
    expect(html).toContain("Buy Course");
    expect(html).toContain('href="/courses/11/payment"');
    expect(html).not.toContain("Go to Course");
  });

  it("does not offer a legacy request when purchasing is unavailable", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: false,
        enrollment_status: "none",
        purchase_available: false,
      },
    });

    expect(html).toContain("Purchase Unavailable");
    expect(html).not.toContain("Request Access");
    expect(html).not.toContain('href="/courses/11/payment"');
  });

  it("explains when purchase is unavailable because the course price is not configured", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        price: 0,
        is_enrolled: false,
        enrollment_status: "none",
        purchase_available: false,
      },
    });

    expect(html).toContain("Enrollment price has not been configured for this track.");
    expect(html).toContain("Purchase Unavailable");
  });

  it("does not render Go to Course for coming soon courses", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        launch_status: "coming_soon",
        is_enrolled: true,
        enrollment_status: "approved",
      },
    });

    expect(html).toContain("Coming Soon");
    expect(html).not.toContain("Go to Course");
  });
});
