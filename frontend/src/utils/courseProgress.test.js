import { describe, expect, it } from "vitest";

import { formatCourseCategory, getCourseActionLabel, getCourseProgress } from "./courseProgress";

describe("getCourseProgress", () => {
  it("summarises a course in progress", () => {
    const progress = getCourseProgress({
      lecture_count: 20,
      started_lecture_count: 8,
      completed_lecture_count: 6,
      progress_percent: 30,
    });
    expect(progress).toMatchObject({ percent: 30, status: "in-progress", summary: "6 of 20 lessons done" });
    expect(getCourseActionLabel(progress)).toBe("Continue");
  });

  it("handles not started, completed and empty curricula", () => {
    const fresh = getCourseProgress({ lecture_count: 1, progress_percent: 0 });
    expect(fresh).toMatchObject({ status: "not-started", summary: "1 lesson" });
    expect(getCourseActionLabel(fresh)).toBe("Start");

    const done = getCourseProgress({ lecture_count: 5, completed_lecture_count: 5, progress_percent: 100 });
    expect(done).toMatchObject({ status: "completed", summary: "All lessons done" });
    expect(getCourseActionLabel(done)).toBe("Review");

    expect(getCourseProgress({}).summary).toBe("Lessons coming soon");
  });

  it("computes and clamps the percentage when the API omits or overstates it", () => {
    expect(getCourseProgress({ lecture_count: 4, completed_lecture_count: 1 }).percent).toBe(25);
    expect(getCourseProgress({ lecture_count: 4, progress_percent: 140 }).percent).toBe(100);
    expect(getCourseProgress(null).percent).toBe(0);
  });

  it("labels categories", () => {
    expect(formatCourseCategory("web_pentesting")).toBe("Web & API pentesting");
    expect(formatCourseCategory("osint")).toBe("OSINT");
  });
});
