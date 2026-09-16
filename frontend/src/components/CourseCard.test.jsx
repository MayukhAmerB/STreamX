import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import CourseCard from "./CourseCard";

function renderCourseCard(props) {
  return renderToStaticMarkup(
    <StaticRouter location="/courses">
      <CourseCard {...props} />
    </StaticRouter>,
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

  it("shows only the details action and hides pricing and checkout on public cards", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        purchase_available: true,
        monthly_price: 1500,
        installment_payment_enabled: true,
      },
    });

    expect(html).toContain("See Details");
    expect(html).toContain('href="/courses/11"');
    expect(html).not.toContain("3,500");
    expect(html).not.toContain("Price on request");
    expect(html).not.toContain("Buy Course");
    expect(html).not.toContain('href="/courses/11/payment"');
  });

  it("keeps enrolled courses in the details-first public browsing flow", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: true,
        enrollment_status: "approved",
      },
    });

    expect(html).toContain("See Details");
    expect(html).not.toContain("Access Course");
    expect(html).not.toContain('href="/learn/11"');
  });

  it("keeps pentesting applications inside the course details page", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        category: "web_pentesting",
        purchase_available: false,
      },
    });

    expect(html).toContain("See Details");
    expect(html).toContain('href="/courses/11"');
    expect(html).not.toContain("Apply for Course");
    expect(html).not.toContain('href="/courses/11/register"');
  });

  it("keeps closed and coming-soon programs open for details", () => {
    const closedHtml = renderCourseCard({
      course: { ...baseCourse, registration_closed: true },
    });
    const comingSoonHtml = renderCourseCard({
      course: { ...baseCourse, launch_status: "coming_soon" },
    });

    expect(closedHtml).toContain("Previous batch");
    expect(closedHtml).toContain("See Details");
    expect(comingSoonHtml).toContain("Coming Soon");
    expect(comingSoonHtml).toContain("See Details");
  });

  it("renders real verified ratings and compact learning facts", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        average_rating: 4.8,
        review_count: 27,
        total_hours: 18,
        lecture_count: 42,
      },
    });

    expect(html).toContain("4.8");
    expect(html).toContain("27 reviews");
    expect(html).toContain('href="/courses/11#reviews"');
    expect(html).toContain("18 total hours");
    expect(html).toContain("42 lectures");
    expect(html).toContain("Advanced");
    expect(html).toContain('src="/course-art/osint-program-v2.png"');
  });

  it("does not invent ratings when a course has no approved reviews", () => {
    const html = renderCourseCard({
      course: { ...baseCourse, average_rating: null, review_count: 0 },
    });

    expect(html).toContain("New");
    expect(html).toContain("0 reviews");
    expect(html).not.toContain("5.0");
  });
});
