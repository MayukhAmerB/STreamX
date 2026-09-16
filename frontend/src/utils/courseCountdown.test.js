import { describe, expect, it } from "vitest";

import { getCountdownParts, selectActiveCourseCountdown } from "./courseCountdown";

describe("course countdown", () => {
  const now = Date.parse("2026-09-16T00:00:00Z");

  it("breaks a future deadline into stable timer units", () => {
    expect(getCountdownParts("2026-09-18T03:04:05Z", now)).toEqual({
      days: 2,
      hours: 3,
      minutes: 4,
      seconds: 5,
    });
  });

  it("ignores missing, invalid, and expired deadlines", () => {
    expect(getCountdownParts("", now)).toBeNull();
    expect(getCountdownParts("not-a-date", now)).toBeNull();
    expect(getCountdownParts("2026-09-15T23:59:59Z", now)).toBeNull();
  });

  it("selects the nearest future admin deadline", () => {
    const active = selectActiveCourseCountdown(
      [
        { id: 1, hero_countdown_end_at: "2026-10-01T00:00:00Z" },
        {
          id: 2,
          title: "OSINT Batch IV",
          hero_countdown_label: "Applications close in",
          hero_countdown_end_at: "2026-09-20T00:00:00Z",
        },
        { id: 3, hero_countdown_end_at: "2026-09-01T00:00:00Z" },
      ],
      now,
    );

    expect(active.course.id).toBe(2);
    expect(active.label).toBe("Applications close in");
    expect(active.parts.days).toBe(4);
  });
});
