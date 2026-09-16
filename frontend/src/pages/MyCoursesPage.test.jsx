import { describe, expect, it } from "vitest";

import { getStudentLibraryStats } from "./MyCoursesPage";

describe("getStudentLibraryStats", () => {
  it("summarizes ready, active, and completed courses", () => {
    expect(
      getStudentLibraryStats([
        { id: 1, progress_percent: 0 },
        { id: 2, progress_percent: 45 },
        { id: 3, progress_percent: 100 },
      ]),
    ).toEqual({ total: 3, inProgress: 1, completed: 1 });
  });

  it("handles an invalid response safely", () => {
    expect(getStudentLibraryStats(null)).toEqual({ total: 0, inProgress: 0, completed: 0 });
  });
});
