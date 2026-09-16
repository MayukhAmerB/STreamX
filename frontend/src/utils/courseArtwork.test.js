import { describe, expect, it } from "vitest";

import { resolveCourseArtwork, resolveCourseArtworkFallback } from "./courseArtwork";

describe("resolveCourseArtwork", () => {
  it("keeps an admin-configured thumbnail", () => {
    expect(resolveCourseArtwork({ category: "osint", thumbnail: "https://example.com/course.jpg" }))
      .toBe("https://example.com/course.jpg");
  });

  it("uses bundled artwork for the two flagship categories", () => {
    expect(resolveCourseArtwork({ category: "osint" })).toBe("/course-art/osint-program-v2.png");
    expect(resolveCourseArtwork({ category: "web_pentesting" }))
      .toBe("/course-art/pentesting-program-v2.png");
  });

  it("does not invent artwork for an unknown category", () => {
    expect(resolveCourseArtwork({ category: "other" })).toBe("");
  });

  it("can recover the bundled category artwork after an admin image fails", () => {
    expect(resolveCourseArtworkFallback("web_pentesting"))
      .toBe("/course-art/pentesting-program-v2.png");
  });
});
