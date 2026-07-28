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

    expect(html).toContain("Continue Course");
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
    expect(html).toContain("Enroll Now");
    expect(html).toContain('href="/courses/11/payment"');
    expect(html).not.toContain("Continue Course");
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

  it("shows Registration Closed for a previous batch", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: false,
        enrollment_status: "none",
        registration_closed: true,
        purchase_available: false,
        purchase_unavailable_reason: "registration_closed",
      },
    });

    expect(html).toContain("Registration Closed");
    expect(html).toContain("Previous batch");
    expect(html).not.toContain('href="/courses/11/payment"');
    expect(html).not.toContain("Purchase Unavailable");
  });

  it("keeps a closed previous batch accessible to an enrolled student", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        is_enrolled: true,
        enrollment_status: "approved",
        registration_closed: true,
        purchase_available: false,
        purchase_unavailable_reason: "registration_closed",
      },
    });

    expect(html).toContain("Continue Course");
    expect(html).toContain('href="/learn/11"');
    expect(html).not.toContain("Registration Closed");
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
    expect(html).not.toContain("Continue Course");
  });

  it("renders the default premium feature set when the API has no custom features", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        purchase_available: true,
      },
    });

    expect(html).toContain("Live Sessions");
    expect(html).toContain("Course Completion Certificate");
    expect(html).toContain("24x7 Team Chat Support");
  });

  it("renders admin-configured course-card features", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        purchase_available: true,
        course_card_features: [
          {
            icon: "recording",
            title: "Private Recording Vault",
            description: "Revisit every lesson after the live program.",
          },
        ],
      },
    });

    expect(html).toContain("Private Recording Vault");
    expect(html).toContain("Revisit every lesson after the live program.");
    expect(html).not.toContain("24x7 Team Chat Support");
  });
});
