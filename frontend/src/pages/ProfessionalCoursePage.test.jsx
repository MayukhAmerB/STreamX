import { describe, expect, it, vi } from "vitest";

import {
  formatCourseStartDate,
  getCourseCatalogPath,
  getCourseDetailArtwork,
  getCourseDetailPriceLabel,
  scrollToCourseHash,
  shouldShowCoursePrice,
} from "./ProfessionalCoursePage";

describe("getCourseDetailPriceLabel", () => {
  it("formats the admin-controlled course fee on the details page", () => {
    expect(getCourseDetailPriceLabel({ price: 3500 })).toContain("3,500");
  });

  it("does not present a zero price as purchasable", () => {
    expect(getCourseDetailPriceLabel({ price: 0 })).toBe("To be announced");
  });

  it("hides fees for coming-soon and closed courses", () => {
    expect(
      shouldShowCoursePrice({ launch_status: "coming_soon", price: 18999 })
    ).toBe(false);
    expect(
      shouldShowCoursePrice({ launch_status: "live", registration_closed: true, price: 18999 })
    ).toBe(false);
    expect(
      shouldShowCoursePrice({ launch_status: "live", registration_closed: false, price: 18999 })
    ).toBe(true);
  });

  it("returns students to the matching course category", () => {
    expect(getCourseCatalogPath({ category: "osint" })).toBe("/courses?category=osint");
    expect(getCourseCatalogPath({ category: "web_pentesting" })).toBe(
      "/courses?category=web_pentesting"
    );
    expect(getCourseCatalogPath({ category: "other" })).toBe("/courses");
  });

  it("formats admin-controlled course start dates without inventing a date", () => {
    expect(formatCourseStartDate("2027-01-10")).toContain("2027");
    expect(formatCourseStartDate("")).toBe("To be announced");
    expect(formatCourseStartDate("invalid")).toBe("To be announced");
  });

  it("uses course-specific artwork while keeping admin imagery highest priority", () => {
    expect(getCourseDetailArtwork({ category: "osint" })).toBe(
      "/course-art/osint-detail-operations-v1.png"
    );
    expect(getCourseDetailArtwork({ category: "web_pentesting" })).toBe(
      "/course-art/pentesting-detail-lab-v1.png"
    );
    expect(
      getCourseDetailArtwork({
        category: "osint",
        show_course_image: true,
        thumbnail: "https://example.com/admin-course.jpg",
      })
    ).toBe("https://example.com/admin-course.jpg");
  });

  it("scrolls and focuses a requested course section after async content is available", () => {
    const target = {
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
    };
    const documentRef = {
      getElementById: vi.fn(() => target),
    };

    expect(scrollToCourseHash("#reviews", documentRef)).toBe(true);
    expect(documentRef.getElementById).toHaveBeenCalledWith("reviews");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not scroll when the requested section is unavailable", () => {
    expect(scrollToCourseHash("#reviews", { getElementById: () => null })).toBe(false);
    expect(scrollToCourseHash("#%E0%A4%A", { getElementById: () => null })).toBe(false);
  });
});
