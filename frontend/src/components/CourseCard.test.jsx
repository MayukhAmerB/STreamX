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

    expect(html).toContain("Access Course");
    expect(html).toContain('href="/learn/11"');
    expect(html).toContain('href="/courses/11"');
    expect(html).toContain("View details");
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
    expect(html).not.toContain("Access Course");
    expect(html).toContain('aria-label="View full details for OSINT Professional Training Program"');
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
    expect(html).toContain('href="/courses/11"');
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

    expect(html).toContain("Access Course");
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
    expect(html).not.toContain("Access Course");
  });

  it("renders a concise default feature set when the API has no custom features", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        purchase_available: true,
      },
    });

    expect(html).toContain("Live classes");
    expect(html).toContain("Practical learning");
    expect(html).toContain("Certificate");
    expect(html).toContain('src="/course-art/osint-program-v2.png"');
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
    expect(html).not.toContain("Practical learning");
  });

  it("shows admin-managed facts, pricing, and the full-detail card destination", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        duration: "3 months",
        schedule: "Friday to Sunday",
        total_classes: 36,
        start_date: "2026-10-01",
        purchase_available: true,
        monthly_price: 1500,
        installment_payment_enabled: true,
      },
    });

    expect(html).toContain("3 months");
    expect(html).toContain("Friday to Sunday");
    expect(html).toContain("36 live classes");
    expect(html).toContain("1 Oct 2026");
    expect(html).toContain("/ month");
    expect(html).toContain('href="/courses/11"');
  });

  it("routes pentesting applications through the required application flow", () => {
    const html = renderCourseCard({
      course: {
        ...baseCourse,
        category: "web_pentesting",
        purchase_available: false,
      },
    });

    expect(html).toContain("Apply for Course");
    expect(html).toContain('href="/courses/11/register"');
  });
});
