import { describe, expect, it } from "vitest";
import {
  HLS_MEDIA_ERROR,
  HLS_NETWORK_ERROR,
  LIVE_RESUME_JITTER_MS,
  MAX_IN_PLACE_NETWORK_ATTEMPTS,
  PLAYBACK_FREEZE_THRESHOLD_MS,
  PLAYBACK_STARTUP_GRACE_MS,
  RECOVERY_ACTIONS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  decideHlsErrorAction,
  decideMediaElementEventAction,
  evaluatePlaybackFreeze,
  initialHlsRecoveryState,
  isAutoplayBlockedError,
  isBufferingEvent,
  jitteredBackoffDelay,
  normalizeStreamStatus,
  randomJitterDelay,
  shouldReloadOnStreamLive,
  shouldRenewBootstrapInBackground,
} from "./hlsPlaybackRecovery";

// Small deterministic PRNG so the jitter tests are reproducible.
const seededRandom = (seed = 42) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const runErrorSequence = (errors) => {
  let state = { ...initialHlsRecoveryState };
  return errors.map((error) => {
    const decision = decideHlsErrorAction(error, state);
    state = decision.state;
    return decision.action;
  });
};

describe("jitteredBackoffDelay", () => {
  it("keeps every delay within 0.5x-1.5x of the exponential base and under the cap", () => {
    const random = seededRandom(7);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
      for (let sample = 0; sample < 200; sample += 1) {
        const delay = jitteredBackoffDelay(attempt, { random });
        expect(delay).toBeGreaterThanOrEqual(Math.floor(base * 0.5));
        expect(delay).toBeLessThanOrEqual(Math.min(RETRY_MAX_MS, Math.ceil(base * 1.5)));
      }
    }
  });

  it("uses the exact bounds at the extremes of the random source", () => {
    expect(jitteredBackoffDelay(0, { random: () => 0 })).toBe(RETRY_BASE_MS * 0.5);
    expect(jitteredBackoffDelay(0, { random: () => 0.999999 })).toBe(Math.round(RETRY_BASE_MS * 1.499999));
    expect(jitteredBackoffDelay(2, { random: () => 0.5 })).toBe(RETRY_BASE_MS * 4);
    expect(jitteredBackoffDelay(50, { random: () => 0.999999 })).toBe(RETRY_MAX_MS);
  });

  it("is not constant across viewers hitting the same attempt", () => {
    const random = seededRandom(123);
    const samples = new Set(Array.from({ length: 100 }, () => jitteredBackoffDelay(3, { random })));
    expect(samples.size).toBeGreaterThan(50);
    const values = [...samples];
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(RETRY_BASE_MS * 2);
  });

  it("spreads capped retries instead of pinning them to the cap", () => {
    const random = seededRandom(99);
    const samples = Array.from({ length: 200 }, () => jitteredBackoffDelay(20, { random }));
    expect(Math.min(...samples)).toBeLessThan(RETRY_MAX_MS * 0.75);
    expect(Math.max(...samples)).toBeLessThanOrEqual(RETRY_MAX_MS);
  });

  it("grows with the attempt number on average", () => {
    const mid = { random: () => 0.5 };
    expect(jitteredBackoffDelay(1, mid)).toBeGreaterThan(jitteredBackoffDelay(0, mid));
    expect(jitteredBackoffDelay(3, mid)).toBeGreaterThan(jitteredBackoffDelay(1, mid));
  });

  it("keeps RETRY_MAX_MS in the 10-15 second range", () => {
    expect(RETRY_MAX_MS).toBeGreaterThanOrEqual(10_000);
    expect(RETRY_MAX_MS).toBeLessThanOrEqual(15_000);
  });

  it("tolerates invalid inputs", () => {
    expect(jitteredBackoffDelay(-3, { random: () => 0.5 })).toBe(RETRY_BASE_MS);
    expect(jitteredBackoffDelay(Number.NaN, { random: () => 0.5 })).toBe(RETRY_BASE_MS);
    expect(jitteredBackoffDelay(0, { random: () => Number.NaN })).toBe(RETRY_BASE_MS);
  });
});

describe("randomJitterDelay", () => {
  it("stays within 0..max and varies", () => {
    const random = seededRandom(5);
    const samples = Array.from({ length: 200 }, () => randomJitterDelay(LIVE_RESUME_JITTER_MS, random));
    samples.forEach((sample) => {
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(LIVE_RESUME_JITTER_MS);
    });
    expect(new Set(samples).size).toBeGreaterThan(100);
  });

  it("defaults to a 0-5 second window", () => {
    expect(LIVE_RESUME_JITTER_MS).toBe(5_000);
    expect(randomJitterDelay(undefined, () => 1)).toBe(5_000);
    expect(randomJitterDelay(undefined, () => 0)).toBe(0);
  });
});

describe("media element events", () => {
  it("treats waiting and stalled as ordinary buffering", () => {
    expect(isBufferingEvent("waiting")).toBe(true);
    expect(isBufferingEvent("stalled")).toBe(true);
    expect(isBufferingEvent("error")).toBe(false);
  });

  it("never rebuilds or reloads for waiting/stalled, however often they fire", () => {
    let state = { ...initialHlsRecoveryState };
    for (let index = 0; index < 50; index += 1) {
      for (const eventType of ["waiting", "stalled"]) {
        for (const usingHlsJs of [true, false]) {
          const decision = decideMediaElementEventAction(eventType, { usingHlsJs, state });
          expect(decision.action).toBe(RECOVERY_ACTIONS.IGNORE);
          state = decision.state;
        }
      }
    }
    expect(state).toEqual(initialHlsRecoveryState);
  });

  it("routes media element errors through the media recovery ladder with hls.js", () => {
    const first = decideMediaElementEventAction("error", { usingHlsJs: true });
    expect(first.action).toBe(RECOVERY_ACTIONS.RECOVER_MEDIA);
    const second = decideMediaElementEventAction("error", { usingHlsJs: true, state: first.state });
    expect(second.action).toBe(RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER);
  });

  it("rebuilds native HLS playback on a media element error", () => {
    expect(decideMediaElementEventAction("error", { usingHlsJs: false }).action).toBe(
      RECOVERY_ACTIONS.REBUILD
    );
  });
});

describe("decideHlsErrorAction", () => {
  it("ignores non-fatal errors, including buffer stalls", () => {
    const decision = decideHlsErrorAction({ fatal: false, type: HLS_MEDIA_ERROR });
    expect(decision.action).toBe(RECOVERY_ACTIONS.IGNORE);
    expect(decideHlsErrorAction({ fatal: false, type: HLS_NETWORK_ERROR, httpStatus: 503 }).action).toBe(
      RECOVERY_ACTIONS.IGNORE
    );
    expect(decision.state).toEqual(initialHlsRecoveryState);
  });

  it("renews access on 401 and 403", () => {
    expect(decideHlsErrorAction({ fatal: true, type: HLS_NETWORK_ERROR, httpStatus: 401 }).action).toBe(
      RECOVERY_ACTIONS.RENEW_ACCESS
    );
    expect(decideHlsErrorAction({ fatal: true, type: HLS_NETWORK_ERROR, httpStatus: 403 }).action).toBe(
      RECOVERY_ACTIONS.RENEW_ACCESS
    );
  });

  it("reloads fatal network errors in place a few times before rebuilding", () => {
    const actions = runErrorSequence(
      Array.from({ length: MAX_IN_PLACE_NETWORK_ATTEMPTS + 2 }, () => ({
        fatal: true,
        type: HLS_NETWORK_ERROR,
        httpStatus: 0,
      }))
    );
    expect(actions.slice(0, MAX_IN_PLACE_NETWORK_ATTEMPTS)).toEqual(
      Array(MAX_IN_PLACE_NETWORK_ATTEMPTS).fill(RECOVERY_ACTIONS.IN_PLACE_LOAD)
    );
    expect(actions.slice(MAX_IN_PLACE_NETWORK_ATTEMPTS)).toEqual([
      RECOVERY_ACTIONS.REBUILD,
      RECOVERY_ACTIONS.REBUILD,
    ]);
    expect(MAX_IN_PLACE_NETWORK_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });

  it("treats upstream 5xx network failures as in-place reloads first", () => {
    expect(decideHlsErrorAction({ fatal: true, type: HLS_NETWORK_ERROR, httpStatus: 503 }).action).toBe(
      RECOVERY_ACTIONS.IN_PLACE_LOAD
    );
  });

  it("recovers media errors, then swaps codec, then rebuilds", () => {
    const mediaError = { fatal: true, type: HLS_MEDIA_ERROR };
    expect(runErrorSequence([mediaError, mediaError, mediaError, mediaError])).toEqual([
      RECOVERY_ACTIONS.RECOVER_MEDIA,
      RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER,
      RECOVERY_ACTIONS.REBUILD,
      RECOVERY_ACTIONS.REBUILD,
    ]);
  });

  it("keeps network and media counters independent", () => {
    const network = { fatal: true, type: HLS_NETWORK_ERROR };
    const media = { fatal: true, type: HLS_MEDIA_ERROR };
    expect(runErrorSequence([network, media, network, media])).toEqual([
      RECOVERY_ACTIONS.IN_PLACE_LOAD,
      RECOVERY_ACTIONS.RECOVER_MEDIA,
      RECOVERY_ACTIONS.IN_PLACE_LOAD,
      RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER,
    ]);
  });

  it("starts the ladder over once the caller resets the state after healthy playback", () => {
    const media = { fatal: true, type: HLS_MEDIA_ERROR };
    const first = decideHlsErrorAction(media);
    expect(decideHlsErrorAction(media, first.state).action).toBe(RECOVERY_ACTIONS.SWAP_CODEC_AND_RECOVER);
    expect(decideHlsErrorAction(media, initialHlsRecoveryState).action).toBe(RECOVERY_ACTIONS.RECOVER_MEDIA);
  });

  it("rebuilds for unrecoverable fatal error types", () => {
    expect(decideHlsErrorAction({ fatal: true, type: "muxError" }).action).toBe(RECOVERY_ACTIONS.REBUILD);
    expect(decideHlsErrorAction({ fatal: true, type: "otherError" }).action).toBe(RECOVERY_ACTIONS.REBUILD);
  });

  it("does not mutate the provided state", () => {
    const state = Object.freeze({ networkAttempts: 1, mediaAttempts: 0 });
    const decision = decideHlsErrorAction({ fatal: true, type: HLS_NETWORK_ERROR }, state);
    expect(state.networkAttempts).toBe(1);
    expect(decision.state.networkAttempts).toBe(2);
  });
});

describe("evaluatePlaybackFreeze", () => {
  const base = {
    now: 1_000_000,
    startedAt: 1_000_000 - 120_000,
    hasPlayedFirstFrame: true,
    paused: false,
    ended: false,
    visible: true,
    online: true,
    consecutiveFreezes: 0,
  };

  it("does nothing during short stalls below the freeze threshold", () => {
    expect(PLAYBACK_FREEZE_THRESHOLD_MS).toBeGreaterThanOrEqual(30_000);
    expect(
      evaluatePlaybackFreeze({ ...base, lastProgressAt: base.now - (PLAYBACK_FREEZE_THRESHOLD_MS - 1) }).action
    ).toBe("none");
    expect(evaluatePlaybackFreeze({ ...base, lastProgressAt: base.now - 6_000 }).action).toBe("none");
  });

  it("recovers in place on the first genuine freeze", () => {
    expect(
      evaluatePlaybackFreeze({ ...base, lastProgressAt: base.now - PLAYBACK_FREEZE_THRESHOLD_MS }).action
    ).toBe(RECOVERY_ACTIONS.IN_PLACE_LOAD);
  });

  it("escalates to a rebuild only on a second consecutive freeze", () => {
    const frozen = { ...base, lastProgressAt: base.now - PLAYBACK_FREEZE_THRESHOLD_MS - 1 };
    expect(evaluatePlaybackFreeze({ ...frozen, consecutiveFreezes: 0 }).action).toBe(
      RECOVERY_ACTIONS.IN_PLACE_LOAD
    );
    expect(evaluatePlaybackFreeze({ ...frozen, consecutiveFreezes: 1 }).action).toBe(RECOVERY_ACTIONS.REBUILD);
    expect(evaluatePlaybackFreeze({ ...frozen, consecutiveFreezes: 3 }).action).toBe(RECOVERY_ACTIONS.REBUILD);
  });

  it("never treats paused, ended, hidden or offline players as frozen", () => {
    const frozen = { ...base, lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS };
    expect(evaluatePlaybackFreeze({ ...frozen, paused: true }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, ended: true }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, visible: false }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, online: false }).action).toBe("resetClock");
  });

  it("gives startup a grace period before the first frame", () => {
    expect(PLAYBACK_STARTUP_GRACE_MS).toBe(45_000);
    const starting = {
      ...base,
      hasPlayedFirstFrame: false,
      lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS,
    };
    // Well past the normal freeze threshold, but still inside the grace period.
    expect(evaluatePlaybackFreeze({ ...starting, startedAt: base.now - 40_000 }).action).toBe("none");
    expect(
      evaluatePlaybackFreeze({ ...starting, startedAt: base.now - (PLAYBACK_STARTUP_GRACE_MS - 1) }).action
    ).toBe("none");
    expect(evaluatePlaybackFreeze({ ...starting, startedAt: base.now - PLAYBACK_STARTUP_GRACE_MS }).action).toBe(
      RECOVERY_ACTIONS.IN_PLACE_LOAD
    );
    expect(
      evaluatePlaybackFreeze({
        ...starting,
        startedAt: base.now - PLAYBACK_STARTUP_GRACE_MS,
        consecutiveFreezes: 1,
      }).action
    ).toBe(RECOVERY_ACTIONS.REBUILD);
  });

  it("does not escalate an autoplay-blocked player that never started", () => {
    expect(
      evaluatePlaybackFreeze({
        ...base,
        hasPlayedFirstFrame: false,
        paused: true,
        startedAt: base.now - 10 * PLAYBACK_STARTUP_GRACE_MS,
      }).action
    ).toBe("resetClock");
  });
});

describe("autoplay helpers", () => {
  it("detects autoplay policy rejections only", () => {
    expect(isAutoplayBlockedError({ name: "NotAllowedError" })).toBe(true);
    expect(isAutoplayBlockedError({ name: "AbortError" })).toBe(false);
    expect(isAutoplayBlockedError(null)).toBe(false);
  });
});

describe("stream status transitions", () => {
  it("normalizes status strings", () => {
    expect(normalizeStreamStatus("  LIVE ")).toBe("live");
    expect(normalizeStreamStatus(null)).toBe("");
  });

  it("reloads only when going live while the player is recovering", () => {
    expect(shouldReloadOnStreamLive({ previousStatus: "offline", nextStatus: "live", recovering: true })).toBe(
      true
    );
    expect(shouldReloadOnStreamLive({ previousStatus: "starting", nextStatus: "LIVE", recovering: true })).toBe(
      true
    );
    expect(shouldReloadOnStreamLive({ previousStatus: "offline", nextStatus: "live", recovering: false })).toBe(
      false
    );
    expect(shouldReloadOnStreamLive({ previousStatus: "live", nextStatus: "live", recovering: true })).toBe(false);
    expect(shouldReloadOnStreamLive({ previousStatus: "", nextStatus: "live", recovering: true })).toBe(false);
    expect(shouldReloadOnStreamLive({ previousStatus: "live", nextStatus: "offline", recovering: true })).toBe(
      false
    );
  });
});

describe("shouldRenewBootstrapInBackground", () => {
  const previous = {
    bootstrapUrl: "/api/realtime/owncast/stream-bridge/?token=old",
    hlsUrl: "/hls/stream.m3u8",
    refreshKey: 0,
    generation: 0,
    sessionId: 7,
  };

  it("renews in the background when only the signed launch URL changed", () => {
    expect(
      shouldRenewBootstrapInBackground({
        previous,
        next: { ...previous, bootstrapUrl: "/api/realtime/owncast/stream-bridge/?token=new" },
        bootstrapReady: true,
      })
    ).toBe(true);
  });

  it("does a full bootstrap before the player is ready", () => {
    expect(
      shouldRenewBootstrapInBackground({
        previous,
        next: { ...previous, bootstrapUrl: "/x?token=new" },
        bootstrapReady: false,
      })
    ).toBe(false);
    expect(shouldRenewBootstrapInBackground({ previous: null, next: previous, bootstrapReady: true })).toBe(false);
  });

  it("does a full bootstrap when the stream, refresh key, generation or session changes", () => {
    const variants = [
      { hlsUrl: "/hls/other.m3u8" },
      { refreshKey: 1 },
      { generation: 1 },
      { sessionId: 8 },
      { bootstrapUrl: "" },
      { hlsUrl: "" },
    ];
    variants.forEach((change) => {
      expect(
        shouldRenewBootstrapInBackground({ previous, next: { ...previous, ...change }, bootstrapReady: true })
      ).toBe(false);
    });
  });
});
