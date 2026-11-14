import { describe, expect, it } from "vitest";

import {
  IDLE_STALL_STATE,
  STALL_REASONS,
  advanceStallState,
  normalizeStallReason,
  resolvePlaybackStallReason,
} from "./playbackStall";

describe("resolvePlaybackStallReason", () => {
  it("is null while the player plays", () => {
    expect(resolvePlaybackStallReason({})).toBeNull();
  });

  it("reports a connection error", () => {
    expect(resolvePlaybackStallReason({ connectionIssue: { message: "x" } })).toBe(STALL_REASONS.CONNECTION);
  });

  it("reports a lost feed as soon as the playlist is gone, before the reconnect overlay", () => {
    expect(resolvePlaybackStallReason({ feedLost: true })).toBe(STALL_REASONS.FEED_LOST);
    expect(resolvePlaybackStallReason({ streamReconnect: { offline: false } })).toBe(STALL_REASONS.FEED_LOST);
    // A lost feed outranks the generic connection error shown meanwhile.
    expect(resolvePlaybackStallReason({ feedLost: true, connectionIssue: { message: "x" } })).toBe(STALL_REASONS.FEED_LOST);
  });
});

describe("normalizeStallReason", () => {
  it("accepts the legacy boolean and the reason strings", () => {
    expect(normalizeStallReason(false)).toBe("");
    expect(normalizeStallReason(null)).toBe("");
    expect(normalizeStallReason(true)).toBe("stalled");
    expect(normalizeStallReason(" Feed-Lost ")).toBe("feed-lost");
  });
});

describe("advanceStallState", () => {
  it("refreshes immediately when playback stalls", () => {
    const step = advanceStallState(IDLE_STALL_STATE, STALL_REASONS.CONNECTION, 1000);
    expect(step).toEqual({ state: { reason: "connection", since: 1000, polls: 0 }, changed: true, refreshNow: true });
  });

  it("does nothing while the same stall continues", () => {
    const stalled = { reason: "connection", since: 1000, polls: 4 };
    const step = advanceStallState(stalled, STALL_REASONS.CONNECTION, 9000);
    expect(step.changed).toBe(false);
    expect(step.refreshNow).toBe(false);
    expect(step.state).toBe(stalled);
  });

  // E2E run-02 shape: the player already showed "Connection error…" when the
  // feed dropped; the lost playlist must still trigger an immediate check and
  // restart the fast-poll window instead of riding the old stall's backoff.
  it("treats a stronger reason during a stall as new evidence", () => {
    const stalled = { reason: "connection", since: 1000, polls: 30 };
    const step = advanceStallState(stalled, STALL_REASONS.FEED_LOST, 95000);
    expect(step).toEqual({ state: { reason: "feed-lost", since: 95000, polls: 0 }, changed: true, refreshNow: true });
  });

  it("resets on recovery without an extra request", () => {
    const step = advanceStallState({ reason: "feed-lost", since: 1, polls: 2 }, null, 5000);
    expect(step).toEqual({ state: IDLE_STALL_STATE, changed: true, refreshNow: false });
  });
});
