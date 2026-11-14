// Regression (E2E run-02): viewers saw "Host reconnecting…" 31 s after the
// feed dropped because a live session was only re-polled every 30 s and the
// player's stall did not speed it up.
import { describe, expect, it } from "vitest";

import {
  STALLED_FAST_WINDOW_MS,
  STALLED_FIRST_POLL_MS,
  VISIBLE_STALLED_POLL_MS,
  resolveBasePollDelay,
  resolveStalledPollDelay,
} from "./useAdaptiveRealtimeSessionPolling";

const live = { sessionStatus: "live", streamStatus: "live", visible: true };

describe("adaptive realtime session polling", () => {
  it("polls a healthy live class slowly", () => {
    expect(resolveBasePollDelay(live)).toBe(30000);
  });

  it("polls within seconds while the viewer's player is stalled", () => {
    const first = resolveBasePollDelay({ ...live, playbackStalled: true, stalledPolls: 0, stalledForMs: 0 });
    const next = resolveBasePollDelay({ ...live, playbackStalled: true, stalledPolls: 3, stalledForMs: 9000 });
    expect(first).toBe(STALLED_FIRST_POLL_MS);
    expect(next).toBe(VISIBLE_STALLED_POLL_MS);
    // The acceptance target: "Host reconnecting…" within a few seconds.
    expect(first).toBeLessThanOrEqual(2000);
    expect(next).toBeLessThanOrEqual(3000);
  });

  it("keeps the recovery pace once the server reports the interruption, stalled or not", () => {
    expect(resolveBasePollDelay({ ...live, streamStatus: "interrupted" })).toBe(6000);
    expect(resolveBasePollDelay({ ...live, streamStatus: "interrupted", playbackStalled: true })).toBe(6000);
  });

  it("stops polling an ended class even if the player is stalled", () => {
    expect(resolveBasePollDelay({ sessionStatus: "ended", streamStatus: "stopped", visible: true, playbackStalled: true })).toBe(0);
  });

  it("backs off in a hidden tab", () => {
    expect(resolveBasePollDelay({ ...live, visible: false, playbackStalled: true })).toBeGreaterThanOrEqual(30000);
  });

  it("backs off a stall the server never confirms, up to the live pace", () => {
    const at = (seconds) => resolveStalledPollDelay({ stalledPolls: 10, stalledForMs: seconds * 1000 });
    expect(at(STALLED_FAST_WINDOW_MS / 1000 - 1)).toBe(VISIBLE_STALLED_POLL_MS);
    expect(at(60)).toBe(6000);
    expect(at(120)).toBe(12000);
    expect(at(180)).toBe(24000);
    expect(at(240)).toBe(30000);
    expect(at(3600)).toBe(30000);
    const delays = [0, 30, 59, 60, 90, 120, 200, 400].map(at);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });
});
