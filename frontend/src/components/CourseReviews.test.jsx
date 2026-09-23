import { describe, expect, it } from "vitest";

import { formatReviewDate } from "./CourseReviews";

describe("formatReviewDate", () => {
  it("formats the review posting date for the student-facing metadata", () => {
    expect(formatReviewDate("2026-09-23T12:00:00.000Z")).toBe("23 Sept 2026");
  });

  it("handles missing or invalid dates without rendering Invalid Date", () => {
    expect(formatReviewDate("")).toBe("Date unavailable");
    expect(formatReviewDate("not-a-date")).toBe("Date unavailable");
  });
});
