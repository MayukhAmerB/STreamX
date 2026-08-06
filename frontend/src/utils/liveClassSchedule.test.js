import { describe, expect, it } from "vitest";
import { findJoinableLiveSession, isJoinableLiveSession, resolveLiveClassSchedule } from "./liveClassSchedule";

describe("live class schedule helpers", () => {
  it("only treats a backend-approved live session as joinable", () => {
    expect(isJoinableLiveSession({ status: "live", viewer_can_join_now: true })).toBe(true);
    expect(
      isJoinableLiveSession({
        status: "live",
        viewer_can_join_now: true,
        session_type: "broadcasting",
        stream_status: "live",
      })
    ).toBe(true);
    expect(
      isJoinableLiveSession({
        status: "live",
        viewer_can_join_now: true,
        session_type: "broadcasting",
        stream_status: "stopped",
      })
    ).toBe(false);
    expect(isJoinableLiveSession({ status: "scheduled", viewer_can_join_now: true })).toBe(false);
    expect(isJoinableLiveSession({ status: "live", viewer_can_join_now: false })).toBe(false);
  });

  it("finds the joinable session for a specific enrolled live class", () => {
    const sessions = [
      { id: 1, status: "live", viewer_can_join_now: true, linked_live_class: { id: 10 } },
      { id: 2, status: "live", viewer_can_join_now: true, linked_live_class: { id: 20 } },
    ];
    expect(findJoinableLiveSession(sessions, 20)?.id).toBe(2);
  });

  it("uses the server-provided schedule snapshot", () => {
    const schedule = { label: "Server schedule", is_open: true };
    expect(resolveLiveClassSchedule([{ live_schedule: schedule }])).toBe(schedule);
  });
});
