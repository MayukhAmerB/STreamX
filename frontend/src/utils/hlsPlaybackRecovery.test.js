import { describe, expect, it } from "vitest";
import {
  HLS_MEDIA_ERROR,
  HLS_NETWORK_ERROR,
  LIVE_RESUME_JITTER_MS,
  MAX_IN_PLACE_NETWORK_ATTEMPTS,
  OFFLINE_TAIL_STALL_MS,
  PLAYBACK_FREEZE_THRESHOLD_MS,
  PLAYBACK_STARTUP_GRACE_MS,
  PROBE_ACTIONS,
  PROBE_RESULTS,
  RECOVERY_ACTIONS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  STREAM_INTERRUPTIONS,
  STREAM_OFFLINE_SIGNALS,
  STREAM_PROBE_BASE_MS,
  STREAM_PROBE_MAX_MS,
  buildStreamOutageReport,
  classifyPlaylistProbe,
  classifyStreamInterruption,
  decideHlsErrorAction,
  decideMediaElementEventAction,
  decideStreamProbeAction,
  evaluatePlaybackFreeze,
  findOfflineSlateStart,
  hasPlaylistAdvanced,
  hasReachedOfflineTail,
  initialHlsRecoveryState,
  isAutoplayBlockedError,
  isBufferingEvent,
  isEndedLevelDetails,
  isPlaylistMissingError,
  isSessionExpectedLive,
  jitteredBackoffDelay,
  normalizeStreamStatus,
  parseHlsPlaylist,
  playlistSnapshot,
  randomJitterDelay,
  shouldReloadOnStreamLive,
  shouldRenewBootstrapInBackground,
  streamProbeDelay,
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

  it("never treats paused, hidden or offline players as frozen", () => {
    const frozen = { ...base, lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS };
    expect(evaluatePlaybackFreeze({ ...frozen, paused: true }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, visible: false }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, online: false }).action).toBe("resetClock");
  });

  // Behaviour change: "ended" used to reset the clock, which left every
  // viewer frozen after an encoder blip. A live class that ended waits for
  // the stream instead; only a class the backend ended stays stopped.
  it("waits for the stream when a live class reaches ended", () => {
    const frozen = { ...base, lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS };
    expect(evaluatePlaybackFreeze({ ...frozen, ended: true }).action).toBe(RECOVERY_ACTIONS.AWAIT_STREAM);
    expect(evaluatePlaybackFreeze({ ...frozen, ended: true, expectLive: true }).action).toBe(
      RECOVERY_ACTIONS.AWAIT_STREAM
    );
    // Even before the first frame and while hidden or offline.
    expect(
      evaluatePlaybackFreeze({ ...frozen, ended: true, hasPlayedFirstFrame: false, visible: false, online: false })
        .action
    ).toBe(RECOVERY_ACTIONS.AWAIT_STREAM);
  });

  it("keeps resetting the clock when the session itself ended", () => {
    const frozen = { ...base, lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS };
    expect(evaluatePlaybackFreeze({ ...frozen, ended: true, expectLive: false }).action).toBe("resetClock");
  });

  it("never escalates while already waiting for the stream to return", () => {
    const frozen = { ...base, lastProgressAt: base.now - 10 * PLAYBACK_FREEZE_THRESHOLD_MS };
    expect(evaluatePlaybackFreeze({ ...frozen, awaitingStream: true }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, awaitingStream: true, ended: true }).action).toBe("resetClock");
    expect(evaluatePlaybackFreeze({ ...frozen, awaitingStream: true, consecutiveFreezes: 5 }).action).toBe(
      "resetClock"
    );
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

const LIVE_MEDIA_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:120",
  "#EXTINF:4.000000,",
  "stream-abc-120.ts",
  "#EXTINF:4.000000,",
  "stream-abc-121.ts",
  "#EXTINF:4.000000,",
  "stream-abc-122.ts",
].join("\n");

// What Owncast 0.2.x serves after the encoder drops: the old window plus an
// offline clip and #EXT-X-ENDLIST.
const OWNCAST_OFFLINE_PLAYLIST = [
  LIVE_MEDIA_PLAYLIST,
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:8.000000,",
  "offline.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const MASTER_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:6",
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
  "0/stream.m3u8",
  "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360",
  "1/stream.m3u8",
].join("\n");

describe("session end versus stream blip", () => {
  it("expects every session except an ended one to be live", () => {
    expect(isSessionExpectedLive("live")).toBe(true);
    expect(isSessionExpectedLive("scheduled")).toBe(true);
    expect(isSessionExpectedLive("")).toBe(true);
    expect(isSessionExpectedLive(undefined)).toBe(true);
    expect(isSessionExpectedLive("ended")).toBe(false);
    expect(isSessionExpectedLive(" ENDED ")).toBe(false);
  });

  it("classifies every offline signal as a blip while the session is live", () => {
    Object.values(STREAM_OFFLINE_SIGNALS).forEach((signal) => {
      expect(classifyStreamInterruption({ signal, sessionStatus: "live" })).toBe(STREAM_INTERRUPTIONS.STREAM_OFFLINE);
      expect(classifyStreamInterruption({ signal, sessionStatus: "" })).toBe(STREAM_INTERRUPTIONS.STREAM_OFFLINE);
    });
  });

  it("classifies the same signals as a real end once the backend ended the session", () => {
    Object.values(STREAM_OFFLINE_SIGNALS).forEach((signal) => {
      expect(classifyStreamInterruption({ signal, sessionStatus: "ended" })).toBe(STREAM_INTERRUPTIONS.SESSION_ENDED);
    });
  });

  it("ignores unrelated signals", () => {
    expect(classifyStreamInterruption({ signal: "waiting", sessionStatus: "live" })).toBe(STREAM_INTERRUPTIONS.NONE);
    expect(classifyStreamInterruption({ signal: "", sessionStatus: "ended" })).toBe(STREAM_INTERRUPTIONS.NONE);
    expect(classifyStreamInterruption()).toBe(STREAM_INTERRUPTIONS.NONE);
  });
});

describe("offline detection helpers", () => {
  it("detects an ENDLIST level only when hls.js marks it not live", () => {
    expect(isEndedLevelDetails({ live: false })).toBe(true);
    expect(isEndedLevelDetails({ live: true })).toBe(false);
    expect(isEndedLevelDetails({})).toBe(false);
    expect(isEndedLevelDetails(null)).toBe(false);
  });

  it("treats only missing playlists as the stream being offline", () => {
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "manifestLoadError", httpStatus: 404 })).toBe(
      true
    );
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "levelLoadError", httpStatus: 410 })).toBe(true);
    // Segment 404s, auth failures, server errors and media errors keep the
    // normal recovery ladder.
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "fragLoadError", httpStatus: 404 })).toBe(false);
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "levelLoadError", httpStatus: 403 })).toBe(
      false
    );
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "levelLoadError", httpStatus: 503 })).toBe(
      false
    );
    expect(isPlaylistMissingError({ type: HLS_NETWORK_ERROR, details: "levelLoadError", httpStatus: 0 })).toBe(false);
    expect(isPlaylistMissingError({ type: HLS_MEDIA_ERROR, details: "levelLoadError", httpStatus: 404 })).toBe(false);
    expect(isPlaylistMissingError()).toBe(false);
  });

  it("finds where Owncast's offline clip starts", () => {
    const fragments = [
      { start: 100, relurl: "stream-abc-120.ts" },
      { start: 104, relurl: "stream-abc-121.ts" },
      { start: 108, relurl: "offline.ts" },
    ];
    expect(findOfflineSlateStart(fragments)).toBe(108);
    expect(findOfflineSlateStart([{ start: 12, url: "https://x/hls/0/offline.ts?token=1" }])).toBe(12);
  });

  it("returns null when there is no offline clip", () => {
    expect(findOfflineSlateStart([{ start: 0, relurl: "stream-abc-1.ts" }])).toBeNull();
    expect(findOfflineSlateStart([{ start: 0, relurl: "stream-offline-like-name.ts" }])).toBeNull();
    expect(findOfflineSlateStart([{ relurl: "offline.ts" }])).toBeNull();
    expect(findOfflineSlateStart([])).toBeNull();
    expect(findOfflineSlateStart(null)).toBeNull();
  });

  it("knows when the buffered class content has been watched", () => {
    expect(hasReachedOfflineTail({ ended: true })).toBe(true);
    expect(hasReachedOfflineTail({ currentTime: 107.8, slateStart: 108 })).toBe(true);
    expect(hasReachedOfflineTail({ currentTime: 109, slateStart: 108 })).toBe(true);
    expect(hasReachedOfflineTail({ currentTime: 100, slateStart: 108 })).toBe(false);
    expect(hasReachedOfflineTail({ currentTime: 100, slateStart: null, msSinceProgress: OFFLINE_TAIL_STALL_MS })).toBe(
      true
    );
    expect(
      hasReachedOfflineTail({ currentTime: 100, slateStart: null, msSinceProgress: OFFLINE_TAIL_STALL_MS - 1 })
    ).toBe(false);
  });

  it("does not treat a viewer pause as the end of the tail", () => {
    expect(
      hasReachedOfflineTail({ currentTime: 50, slateStart: 108, msSinceProgress: 60_000, pausedByViewer: true })
    ).toBe(false);
    expect(hasReachedOfflineTail({ ended: true, pausedByViewer: true })).toBe(true);
  });

  it("does not mistake a slate at time zero for missing data", () => {
    expect(hasReachedOfflineTail({ currentTime: 0, slateStart: 0 })).toBe(true);
    expect(hasReachedOfflineTail({ currentTime: 0, slateStart: undefined })).toBe(false);
  });
});

describe("streamProbeDelay", () => {
  it("starts around two seconds", () => {
    expect(STREAM_PROBE_BASE_MS).toBe(2_000);
    expect(streamProbeDelay(0, { random: () => 0 })).toBe(1_000);
    expect(streamProbeDelay(0, { random: () => 1 })).toBe(2_000);
  });

  it("caps at ten seconds", () => {
    expect(STREAM_PROBE_MAX_MS).toBe(10_000);
    expect(streamProbeDelay(3, { random: () => 1 })).toBe(10_000);
    expect(streamProbeDelay(50, { random: () => 1 })).toBe(10_000);
    expect(streamProbeDelay(Number.POSITIVE_INFINITY, { random: () => 1 })).toBe(10_000);
  });

  it("keeps every delay within [0.5x, 1x] of the capped exponential ceiling", () => {
    const random = seededRandom(11);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(STREAM_PROBE_MAX_MS, STREAM_PROBE_BASE_MS * 2 ** attempt);
      for (let sample = 0; sample < 200; sample += 1) {
        const delay = streamProbeDelay(attempt, { random });
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.5));
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeLessThanOrEqual(STREAM_PROBE_MAX_MS);
      }
    }
  });

  it("spreads an audience out instead of pinning capped probes to one value", () => {
    const random = seededRandom(2024);
    const samples = Array.from({ length: 500 }, () => streamProbeDelay(20, { random }));
    expect(new Set(samples).size).toBeGreaterThan(300);
    expect(Math.min(...samples)).toBeLessThan(STREAM_PROBE_MAX_MS * 0.6);
    expect(samples.filter((sample) => sample === STREAM_PROBE_MAX_MS).length).toBeLessThan(5);
  });

  it("uses the injected random source", () => {
    expect(streamProbeDelay(1, { random: () => 0.5 })).toBe(3_000);
    expect(streamProbeDelay(1, { random: () => 0 })).not.toBe(streamProbeDelay(1, { random: () => 1 }));
  });

  it("probes hidden tabs at the slowest tier", () => {
    expect(streamProbeDelay(0, { random: () => 0, hidden: true })).toBe(STREAM_PROBE_MAX_MS / 2);
    expect(streamProbeDelay(0, { random: () => 1, hidden: true })).toBe(STREAM_PROBE_MAX_MS);
  });

  it("tolerates invalid inputs", () => {
    expect(streamProbeDelay(-4, { random: () => 1 })).toBe(2_000);
    expect(streamProbeDelay(Number.NaN, { random: () => 1 })).toBe(2_000);
    expect(streamProbeDelay(0, { random: () => Number.NaN })).toBe(1_500);
  });
});

describe("parseHlsPlaylist", () => {
  it("reads a live media playlist", () => {
    const playlist = parseHlsPlaylist(LIVE_MEDIA_PLAYLIST);
    expect(playlist).toMatchObject({
      valid: true,
      isMaster: false,
      endList: false,
      mediaSequence: 120,
      segmentCount: 3,
      lastSegmentUri: "stream-abc-122.ts",
    });
  });

  it("reads Owncast's offline playlist as ended", () => {
    const playlist = parseHlsPlaylist(OWNCAST_OFFLINE_PLAYLIST);
    expect(playlist.endList).toBe(true);
    expect(playlist.lastSegmentUri).toBe("offline.ts");
    expect(playlist.segmentCount).toBe(4);
  });

  it("reads a master playlist's variants", () => {
    const playlist = parseHlsPlaylist(MASTER_PLAYLIST);
    expect(playlist.isMaster).toBe(true);
    expect(playlist.variantUris).toEqual(["0/stream.m3u8", "1/stream.m3u8"]);
    expect(playlist.segmentCount).toBe(0);
  });

  it("handles CRLF line endings and a byte order mark", () => {
    const playlist = parseHlsPlaylist(`\uFEFF${LIVE_MEDIA_PLAYLIST.replace(/\n/g, "\r\n")}`);
    expect(playlist.valid).toBe(true);
    expect(playlist.segmentCount).toBe(3);
  });

  it("rejects anything that is not a playlist", () => {
    expect(parseHlsPlaylist("<html>offline</html>").valid).toBe(false);
    expect(parseHlsPlaylist("").valid).toBe(false);
    expect(parseHlsPlaylist(null).valid).toBe(false);
  });
});

describe("classifyPlaylistProbe", () => {
  it("is live only for a fresh media playlist with segments and no ENDLIST", () => {
    expect(classifyPlaylistProbe({ httpStatus: 200, playlist: parseHlsPlaylist(LIVE_MEDIA_PLAYLIST) })).toBe(
      PROBE_RESULTS.LIVE
    );
  });

  it("is offline for an ended, empty or missing playlist", () => {
    expect(classifyPlaylistProbe({ httpStatus: 200, playlist: parseHlsPlaylist(OWNCAST_OFFLINE_PLAYLIST) })).toBe(
      PROBE_RESULTS.OFFLINE
    );
    expect(classifyPlaylistProbe({ httpStatus: 200, playlist: parseHlsPlaylist("#EXTM3U\n#EXT-X-VERSION:3") })).toBe(
      PROBE_RESULTS.OFFLINE
    );
    expect(classifyPlaylistProbe({ httpStatus: 404 })).toBe(PROBE_RESULTS.OFFLINE);
    expect(classifyPlaylistProbe({ httpStatus: 410 })).toBe(PROBE_RESULTS.OFFLINE);
  });

  it("flags access problems separately", () => {
    expect(classifyPlaylistProbe({ httpStatus: 401 })).toBe(PROBE_RESULTS.UNAUTHORIZED);
    expect(classifyPlaylistProbe({ httpStatus: 403 })).toBe(PROBE_RESULTS.UNAUTHORIZED);
  });

  it("is merely unavailable for transient or unreadable responses", () => {
    expect(classifyPlaylistProbe({ httpStatus: 0 })).toBe(PROBE_RESULTS.UNAVAILABLE);
    expect(classifyPlaylistProbe({ httpStatus: 502 })).toBe(PROBE_RESULTS.UNAVAILABLE);
    expect(classifyPlaylistProbe({ httpStatus: 200, playlist: parseHlsPlaylist("nope") })).toBe(
      PROBE_RESULTS.UNAVAILABLE
    );
    expect(classifyPlaylistProbe({ httpStatus: 200, playlist: parseHlsPlaylist(MASTER_PLAYLIST) })).toBe(
      PROBE_RESULTS.UNAVAILABLE
    );
    expect(classifyPlaylistProbe()).toBe(PROBE_RESULTS.UNAVAILABLE);
  });
});

describe("decideStreamProbeAction", () => {
  const live = playlistSnapshot(parseHlsPlaylist(LIVE_MEDIA_PLAYLIST));
  const offline = playlistSnapshot(parseHlsPlaylist(OWNCAST_OFFLINE_PLAYLIST));
  const advanced = { ...live, mediaSequence: live.mediaSequence + 1, lastSegmentUri: "stream-abc-123.ts" };

  it("snapshots only media playlists", () => {
    expect(playlistSnapshot(parseHlsPlaylist(MASTER_PLAYLIST))).toBeNull();
    expect(playlistSnapshot(null)).toBeNull();
    expect(live).toEqual({ endList: false, mediaSequence: 120, segmentCount: 3, lastSegmentUri: "stream-abc-122.ts" });
  });

  it("detects segment movement", () => {
    expect(hasPlaylistAdvanced(live, advanced)).toBe(true);
    expect(hasPlaylistAdvanced(offline, live)).toBe(true);
    expect(hasPlaylistAdvanced(live, { ...live })).toBe(false);
    expect(hasPlaylistAdvanced(null, live)).toBe(false);
    expect(hasPlaylistAdvanced(live, null)).toBe(false);
  });

  it("keeps waiting while the stream is offline and remembers the offline playlist", () => {
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.OFFLINE, snapshot: offline })).toEqual({
      action: PROBE_ACTIONS.WAIT,
      reference: offline,
    });
    expect(
      decideStreamProbeAction({ result: PROBE_RESULTS.UNAVAILABLE, snapshot: null, reference: offline })
    ).toEqual({ action: PROBE_ACTIONS.WAIT, reference: offline });
  });

  it("reattaches once a live playlist has moved on from an earlier probe", () => {
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.LIVE, snapshot: live, reference: offline }).action).toBe(
      PROBE_ACTIONS.REATTACH
    );
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.LIVE, snapshot: advanced, reference: live }).action).toBe(
      PROBE_ACTIONS.REATTACH
    );
  });

  it("confirms a first or unchanged live playlist before reattaching", () => {
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.LIVE, snapshot: live })).toEqual({
      action: PROBE_ACTIONS.CONFIRM,
      reference: live,
    });
    // A frozen playlist keeps the original reference so slow segments still
    // count as advancing later.
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.LIVE, snapshot: { ...live }, reference: live })).toEqual({
      action: PROBE_ACTIONS.CONFIRM,
      reference: live,
    });
  });

  it("hands access problems to the rebuilt player's renewal ladder", () => {
    expect(decideStreamProbeAction({ result: PROBE_RESULTS.UNAUTHORIZED }).action).toBe(PROBE_ACTIONS.REATTACH);
  });
});

describe("buildStreamOutageReport", () => {
  it("reuses the generic upstream reason with a distinct detail", () => {
    expect(buildStreamOutageReport({ kind: "offline" })).toEqual({
      reason: "upstream",
      hlsErrorType: "stream_offline",
      httpStatus: 0,
      retryAttempt: 0,
    });
  });

  it("reports the outage duration on recovery", () => {
    const report = buildStreamOutageReport({ kind: "recovered", outageMs: 12_345.6, attempt: 4 });
    expect(report).toEqual({
      reason: "upstream",
      hlsErrorType: "stream_recovered;outage_ms=12346",
      httpStatus: 0,
      retryAttempt: 4,
    });
  });

  it("stays inside the backend's field limits", () => {
    const report = buildStreamOutageReport({ kind: "recovered", outageMs: Number.MAX_SAFE_INTEGER, attempt: 999 });
    expect(report.hlsErrorType.length).toBeLessThanOrEqual(80);
    expect(report.retryAttempt).toBe(100);
    expect(buildStreamOutageReport({ kind: "recovered", outageMs: -5 }).hlsErrorType).toBe(
      "stream_recovered;outage_ms=0"
    );
  });
});
