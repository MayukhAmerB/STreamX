// Phase 2 player tuning: live latency, jump-to-live and "Host reconnecting".
import { describe, expect, it } from "vitest";

import { resolveTheaterState } from "../components/realtime/BroadcastViewerTheater";
import {
  LIVE_MAX_LATENCY_DURATION_COUNT,
  LIVE_SYNC_DURATION_COUNT,
  PLAYBACK_FREEZE_THRESHOLD_MS,
  isHostReconnecting,
  liveBehindSeconds,
  shouldOfferJumpToLive,
  shouldReloadOnStreamLive,
} from "./hlsPlaybackRecovery";

describe("live HLS tuning", () => {
  it("stays 3 target durations behind the edge and recovers freezes in 12-15 s", () => {
    expect(LIVE_SYNC_DURATION_COUNT).toBe(3);
    expect(LIVE_MAX_LATENCY_DURATION_COUNT).toBeGreaterThan(LIVE_SYNC_DURATION_COUNT);
    expect(PLAYBACK_FREEZE_THRESHOLD_MS).toBeGreaterThanOrEqual(12_000);
    expect(PLAYBACK_FREEZE_THRESHOLD_MS).toBeLessThanOrEqual(15_000);
  });

  it("measures how far behind live the viewer is", () => {
    expect(liveBehindSeconds({ liveSyncPosition: 120, currentTime: 100 })).toBe(20);
    expect(liveBehindSeconds({ liveSyncPosition: 100, currentTime: 104 })).toBe(0);
    expect(liveBehindSeconds({ liveSyncPosition: null, currentTime: 4 })).toBeNull();
    expect(liveBehindSeconds({ liveSyncPosition: 0, currentTime: 4 })).toBeNull();
  });

  it("offers Jump to live only when meaningfully behind and playing", () => {
    expect(shouldOfferJumpToLive({ behindSeconds: 4, targetDuration: 2 })).toBe(false);
    expect(shouldOfferJumpToLive({ behindSeconds: 9, targetDuration: 2 })).toBe(true);
    expect(shouldOfferJumpToLive({ behindSeconds: 9, targetDuration: 4 })).toBe(false); // 4 x 4 s = 16 s
    expect(shouldOfferJumpToLive({ behindSeconds: 30, targetDuration: 2, paused: true })).toBe(false);
    expect(shouldOfferJumpToLive({ behindSeconds: null })).toBe(false);
  });

  it("recognises the server's host-reconnecting state", () => {
    expect(isHostReconnecting("interrupted")).toBe(true);
    expect(isHostReconnecting(" Interrupted ")).toBe(true);
    expect(isHostReconnecting("stopped")).toBe(false);
    expect(resolveTheaterState({ streamStatus: "interrupted", sessionStatus: "live" })).toBe("reconnecting");
    expect(resolveTheaterState({ streamStatus: "interrupted", sessionStatus: "ended" })).toBe("ended");
  });

  it("reloads in place when the host comes back", () => {
    expect(shouldReloadOnStreamLive({ previousStatus: "interrupted", nextStatus: "live", recovering: true })).toBe(true);
  });
});
