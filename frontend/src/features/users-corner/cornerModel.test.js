import { describe, expect, it } from "vitest";

import {
  CORNER_COURSE_PREVIEW_LIMIT,
  formatCountdown,
  formatHubDate,
  getAverageProgress,
  getCountdown,
  getCountdownSegments,
  getCornerGreeting,
  getCoursePreview,
  getFirstName,
  getLiveJoinPath,
  getLiveSummary,
  getStudentStats,
  pickContinueCourse,
} from "./cornerModel";

const course = (id, overrides = {}) => ({
  id,
  title: `Course ${id}`,
  category: "osint",
  lecture_count: 10,
  started_lecture_count: 0,
  completed_lecture_count: 0,
  progress_percent: 0,
  ...overrides,
});

const notStarted = course(1);
const halfway = course(2, { started_lecture_count: 5, completed_lecture_count: 5, progress_percent: 50 });
const justStarted = course(3, { started_lecture_count: 1, completed_lecture_count: 1, progress_percent: 10 });
const done = course(4, { started_lecture_count: 10, completed_lecture_count: 10, progress_percent: 100 });

describe("Console greeting", () => {
  it("greets by first name, falling back to the e-mail name", () => {
    expect(getFirstName({ full_name: "  Asha   Rao " })).toBe("Asha");
    expect(getFirstName({ full_name: "", email: "imran.syed@example.com" })).toBe("Imran");
    expect(getFirstName({})).toBe("");
    expect(getFirstName(null)).toBe("");
    expect(getCornerGreeting({ full_name: "Asha Rao" })).toBe("Welcome back, Asha");
    expect(getCornerGreeting(undefined)).toBe("Welcome back");
  });
});

describe("Continue learning", () => {
  it("prefers the last course opened in the player while it is still owned", () => {
    expect(pickContinueCourse([notStarted, halfway, done], "4")).toBe(done);
    expect(pickContinueCourse([notStarted, halfway, done], 4)).toBe(done);
  });

  it("otherwise picks the furthest course in progress, then the first unfinished one", () => {
    expect(pickContinueCourse([notStarted, justStarted, halfway, done], "99")).toBe(halfway);
    expect(pickContinueCourse([done, notStarted], "")).toBe(notStarted);
    expect(pickContinueCourse([done], "")).toBe(done);
  });

  it("handles no courses or a bad response", () => {
    expect(pickContinueCourse([], "3")).toBeNull();
    expect(pickContinueCourse(null, "3")).toBeNull();
    expect(pickContinueCourse([null, { title: "no id" }], "")).toBeNull();
  });
});

describe("course preview", () => {
  it("shows up to three courses with the Continue learning course first", () => {
    const list = [notStarted, halfway, justStarted, done];
    expect(CORNER_COURSE_PREVIEW_LIMIT).toBe(3);
    expect(getCoursePreview(list, done).map((item) => item.id)).toEqual([4, 1, 2]);
    expect(getCoursePreview(list, null).map((item) => item.id)).toEqual([1, 2, 3]);
    expect(getCoursePreview(undefined, null)).toEqual([]);
  });

  it("counts courses, in progress and completed", () => {
    expect(getStudentStats([notStarted, halfway, justStarted, done])).toEqual({ total: 4, inProgress: 2, completed: 1 });
    expect(getStudentStats(null)).toEqual({ total: 0, inProgress: 0, completed: 0 });
  });
});

describe("live card", () => {
  const schedule = { days: ["Friday"], start_time: "19:00", end_time: "20:00", timezone: "Asia/Kolkata" };

  it("finds the joinable live class and the weekly schedule", () => {
    const live = { id: 9, status: "live", session_type: "meeting", viewer_can_join_now: true, live_schedule: schedule };
    const scheduled = { id: 3, status: "scheduled", session_type: "meeting" };
    const summary = getLiveSummary([scheduled, live]);
    expect(summary.liveSession).toBe(live);
    expect(summary.schedule).toBe(schedule);
  });

  it("only treats a broadcast as live once its stream is", () => {
    const warmingUp = { id: 5, status: "live", session_type: "broadcasting", viewer_can_join_now: true, stream_status: "idle" };
    expect(getLiveSummary([warmingUp]).liveSession).toBeNull();
    expect(getLiveSummary([{ ...warmingUp, stream_status: "live" }]).liveSession?.id).toBe(5);
  });

  it("falls back to the default weekly schedule when nothing is listed", () => {
    const summary = getLiveSummary(null);
    expect(summary.liveSession).toBeNull();
    expect(summary.schedule.days).toEqual(["Friday", "Saturday", "Sunday"]);
  });

  it("joins through the live page's shared-session link", () => {
    expect(getLiveJoinPath({ id: 12 })).toBe("/join-live?session=12");
    expect(getLiveJoinPath({ id: "x" })).toBe("/join-live");
    expect(getLiveJoinPath(null)).toBe("/join-live");
  });
});

describe("Console greeting band", () => {
  const now = new Date("2026-11-10T09:15:00Z");

  it("formats today's date for the eyebrow", () => {
    expect(formatHubDate(now, { timeZone: "Asia/Kolkata" })).toBe("Tuesday 10 November");
    expect(formatHubDate("not a date")).toBe("");
  });

  it("counts down to the next class, rounding up to the minute", () => {
    const in2d4h = new Date(now.getTime() + (2 * 24 + 4) * 3600_000);
    const countdown = getCountdown(in2d4h, now);
    expect(countdown).toMatchObject({ days: 2, hours: 4, minutes: 0, soon: false });
    expect(formatCountdown(countdown)).toBe("Starts in 2 days, 4 hours");
    expect(getCountdownSegments(countdown)).toEqual([{ value: 2, unit: "d" }, { value: 4, unit: "h" }]);

    const in3h20 = getCountdown(new Date(now.getTime() + 3 * 3600_000 + 20 * 60_000), now);
    expect(formatCountdown(in3h20)).toBe("Starts in 3 hours, 20 minutes");
    expect(getCountdownSegments(in3h20)).toEqual([{ value: 3, unit: "h" }, { value: 20, unit: "m" }]);

    const in1day = getCountdown(new Date(now.getTime() + 24 * 3600_000), now);
    expect(formatCountdown(in1day)).toBe("Starts in 1 day");

    const in30s = getCountdown(new Date(now.getTime() + 30_000), now);
    expect(in30s).toMatchObject({ minutes: 1, soon: true });
    expect(formatCountdown(in30s)).toBe("Starting now");
    expect(getCountdownSegments(in30s)).toEqual([]);

    const in5m = getCountdown(new Date(now.getTime() + 4 * 60_000 + 1), now);
    expect(formatCountdown(in5m)).toBe("Starts in 5 minutes");
    expect(getCountdownSegments(in5m)).toEqual([{ value: 5, unit: "m" }]);
  });

  it("treats a started or missing class safely", () => {
    expect(getCountdown(new Date(now.getTime() - 1000), now)).toMatchObject({ soon: true, totalMs: 0 });
    expect(getCountdown(null, now)).toBeNull();
    expect(getCountdown("garbage", now)).toBeNull();
    expect(formatCountdown(null)).toBe("");
  });

  it("averages course progress", () => {
    expect(getAverageProgress([notStarted, halfway, done])).toBe(50);
    expect(getAverageProgress([])).toBe(0);
    expect(getAverageProgress(null)).toBe(0);
  });
});
