import { describe, expect, it } from "vitest";

import {
  CORNER_COURSE_PREVIEW_LIMIT,
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

describe("User's Corner greeting", () => {
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
