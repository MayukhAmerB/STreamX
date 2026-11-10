import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_RESULTS, STREAM_PROBE_MAX_MS } from "./hlsPlaybackRecovery";
import {
  STREAM_PROBE_TIMEOUT_MS,
  STREAM_RECONNECT_PHASES,
  createLivePlaylistProber,
  createStreamReconnectController,
} from "./streamReconnect";

const LIVE = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:7",
  "#EXTINF:4.0,",
  "stream-new-7.ts",
  "#EXTINF:4.0,",
  "stream-new-8.ts",
].join("\n");
const LIVE_ADVANCED = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:8",
  "#EXTINF:4.0,",
  "stream-new-8.ts",
  "#EXTINF:4.0,",
  "stream-new-9.ts",
].join("\n");
const OFFLINE = [
  "#EXTM3U",
  "#EXT-X-MEDIA-SEQUENCE:120",
  "#EXTINF:4.0,",
  "stream-old-120.ts",
  "#EXT-X-DISCONTINUITY",
  "#EXTINF:8.0,",
  "offline.ts",
  "#EXT-X-ENDLIST",
].join("\n");
const MASTER = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=2500000", "0/stream.m3u8"].join("\n");

const HLS_URL = "https://academy.test/hls/stream.m3u8";
const VARIANT_URL = "https://academy.test/hls/0/stream.m3u8";

const playlistResponse = (body, { status = 200, url = VARIANT_URL } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => body,
});

// Serves the master playlist and whatever the variant currently contains.
const createOwncastFetch = (variantBodies) => {
  const queue = [...variantBodies];
  const fetchImpl = vi.fn(async (url) => {
    if (url === HLS_URL) return playlistResponse(MASTER, { url: HLS_URL });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "number") return playlistResponse("", { status: next });
    return playlistResponse(next);
  });
  return fetchImpl;
};

const flushPromises = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

describe("createLivePlaylistProber", () => {
  it("resolves the master playlist once and then only probes the variant", async () => {
    const fetchImpl = createOwncastFetch([LIVE, LIVE_ADVANCED]);
    const probe = createLivePlaylistProber({ url: HLS_URL, fetchImpl });

    const first = await probe();
    expect(first.result).toBe(PROBE_RESULTS.LIVE);
    expect(first.snapshot.lastSegmentUri).toBe("stream-new-8.ts");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([HLS_URL, VARIANT_URL]);

    const second = await probe();
    expect(second.snapshot.lastSegmentUri).toBe("stream-new-9.ts");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([HLS_URL, VARIANT_URL, VARIANT_URL]);
  });

  it("sends the access cookie and bypasses caches like the player does", async () => {
    const fetchImpl = createOwncastFetch([LIVE]);
    await createLivePlaylistProber({ url: HLS_URL, fetchImpl })();
    fetchImpl.mock.calls.forEach(([, options]) => {
      expect(options).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
      expect(options.signal).toBeDefined();
    });
  });

  it("classifies Owncast's ended playlist and missing playlists as offline", async () => {
    expect((await createLivePlaylistProber({ url: HLS_URL, fetchImpl: createOwncastFetch([OFFLINE]) })()).result).toBe(
      PROBE_RESULTS.OFFLINE
    );
    expect((await createLivePlaylistProber({ url: HLS_URL, fetchImpl: createOwncastFetch([404]) })()).result).toBe(
      PROBE_RESULTS.OFFLINE
    );
  });

  it("re-reads the master playlist after the variant disappears", async () => {
    const fetchImpl = createOwncastFetch([LIVE, 404, LIVE]);
    const probe = createLivePlaylistProber({ url: HLS_URL, fetchImpl });
    await probe();
    expect((await probe()).result).toBe(PROBE_RESULTS.OFFLINE);
    await probe();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([HLS_URL, VARIANT_URL, VARIANT_URL, HLS_URL, VARIANT_URL]);
  });

  it("reports network failures and access problems without throwing", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await createLivePlaylistProber({ url: HLS_URL, fetchImpl: failing })()).toEqual({
      result: PROBE_RESULTS.UNAVAILABLE,
      snapshot: null,
    });
    const forbidden = vi.fn(async () => playlistResponse("", { status: 403, url: HLS_URL }));
    expect((await createLivePlaylistProber({ url: HLS_URL, fetchImpl: forbidden })()).result).toBe(
      PROBE_RESULTS.UNAUTHORIZED
    );
    expect((await createLivePlaylistProber({ url: "", fetchImpl: forbidden })()).result).toBe(
      PROBE_RESULTS.UNAVAILABLE
    );
  });

  it("aborts a hanging request after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          })
      );
      const pending = createLivePlaylistProber({ url: HLS_URL, fetchImpl: hanging })();
      await vi.advanceTimersByTimeAsync(STREAM_PROBE_TIMEOUT_MS);
      expect((await pending).result).toBe(PROBE_RESULTS.UNAVAILABLE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when the caller cancels", async () => {
    const hanging = vi.fn(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    const cancel = new AbortController();
    const pending = createLivePlaylistProber({ url: HLS_URL, fetchImpl: hanging })(cancel.signal);
    cancel.abort();
    expect((await pending).result).toBe(PROBE_RESULTS.UNAVAILABLE);
  });
});

describe("createStreamReconnectController", () => {
  let online;
  let visible;

  beforeEach(() => {
    vi.useFakeTimers();
    online = true;
    visible = true;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const setup = ({ variantBodies, random = () => 0.5, initialAttempt = 0 } = {}) => {
    const fetchImpl = createOwncastFetch(variantBodies);
    const probe = vi.fn(createLivePlaylistProber({ url: HLS_URL, fetchImpl }));
    const phases = [];
    const onReattach = vi.fn();
    const onProbeAttempt = vi.fn();
    const controller = createStreamReconnectController({
      probe,
      onReattach,
      onProbeAttempt,
      initialAttempt,
      onPhaseChange: (phase) => phases.push(phase),
      isOnline: () => online,
      isVisible: () => visible,
      random,
    });
    return { controller, probe, fetchImpl, phases, onReattach, onProbeAttempt };
  };

  it("on ended during a live class: shows the reconnecting state, then reattaches when the stream returns", async () => {
    const { controller, probe, phases, onReattach } = setup({ variantBodies: [OFFLINE, OFFLINE, LIVE] });

    // The <video> fired "ended": everything buffered has been watched.
    expect(controller.streamWentOffline({ tailExhausted: true })).toBe(true);
    expect(phases).toEqual([STREAM_RECONNECT_PHASES.WAITING]);
    expect(probe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500); // attempt 0 with random 0.5
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onReattach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000); // attempt 1
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onReattach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_000); // attempt 2: the stream is back
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onReattach).toHaveBeenCalledTimes(1);
    expect(phases).toEqual([STREAM_RECONNECT_PHASES.WAITING, STREAM_RECONNECT_PHASES.RESUMING]);

    // Nothing keeps polling after the reattach.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("confirms a first live playlist is advancing before reattaching", async () => {
    const { controller, probe, onReattach } = setup({ variantBodies: [LIVE, LIVE, LIVE_ADVANCED] });
    controller.streamWentOffline({ tailExhausted: true });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onReattach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000); // unchanged playlist: keep confirming
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onReattach).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(onReattach).toHaveBeenCalledTimes(1);
  });

  it("lets the buffered tail finish before reattaching", async () => {
    const { controller, phases, onReattach } = setup({ variantBodies: [OFFLINE, LIVE] });
    // ENDLIST seen while class content is still buffered.
    controller.streamWentOffline({ tailExhausted: false });
    expect(phases).toEqual([STREAM_RECONNECT_PHASES.DRAINING]);

    await vi.advanceTimersByTimeAsync(1_500 + 3_000);
    expect(onReattach).not.toHaveBeenCalled();

    controller.tailExhausted();
    expect(onReattach).toHaveBeenCalledTimes(1);
    expect(phases).toEqual([STREAM_RECONNECT_PHASES.DRAINING, STREAM_RECONNECT_PHASES.RESUMING]);
  });

  it("moves to waiting when the tail runs out before the stream returns", async () => {
    const { controller, phases } = setup({ variantBodies: [OFFLINE] });
    controller.streamWentOffline();
    controller.tailExhausted();
    expect(phases).toEqual([STREAM_RECONNECT_PHASES.DRAINING, STREAM_RECONNECT_PHASES.WAITING]);
    // A second ended/offline signal is idempotent.
    expect(controller.streamWentOffline({ tailExhausted: true })).toBe(false);
    expect(phases).toHaveLength(2);
  });

  it("backs off with jitter up to the 10 second cap and keeps probing", async () => {
    const { controller, probe } = setup({ variantBodies: [OFFLINE], random: () => 1 });
    controller.streamWentOffline({ tailExhausted: true });
    const expectedDelays = [2_000, 4_000, 8_000, 10_000, 10_000, 10_000];
    for (const [index, delay] of expectedDelays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(probe).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(index + 1);
    }
  });

  it("does not move a whole audience in lock-step", async () => {
    const firstProbeTimes = [];
    for (let viewer = 0; viewer < 50; viewer += 1) {
      const randomValue = viewer / 50;
      const { controller, probe } = setup({ variantBodies: [OFFLINE], random: () => randomValue });
      controller.streamWentOffline({ tailExhausted: true });
      let elapsed = 0;
      while (probe.mock.calls.length === 0 && elapsed < 5_000) {
        await vi.advanceTimersByTimeAsync(50);
        elapsed += 50;
      }
      firstProbeTimes.push(elapsed);
      controller.dispose();
    }
    expect(new Set(firstProbeTimes).size).toBeGreaterThan(10);
    expect(Math.max(...firstProbeTimes)).toBeLessThanOrEqual(2_000);
  });

  it("persists the attempt count so a flapping stream keeps backing off", async () => {
    const { controller, probe, onProbeAttempt } = setup({
      variantBodies: [OFFLINE],
      random: () => 1,
      initialAttempt: 3,
    });
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onProbeAttempt).toHaveBeenLastCalledWith(4);
    expect(controller.getProbeAttempt()).toBe(4);
  });

  it("waits for the network and probes immediately when it returns", async () => {
    online = false;
    const { controller, probe, onReattach } = setup({ variantBodies: [LIVE, LIVE_ADVANCED] });
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probe).not.toHaveBeenCalled();

    online = true;
    controller.handleOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(onReattach).toHaveBeenCalledTimes(1);
  });

  it("keeps a slow safety probe when the browser wrongly reports offline", async () => {
    online = false;
    const { controller, probe } = setup({ variantBodies: [OFFLINE], random: () => 1 });
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(STREAM_PROBE_MAX_MS);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("cancels the in-flight probe when the network drops", async () => {
    const { controller, fetchImpl } = setup({ variantBodies: [OFFLINE] });
    let seenSignal = null;
    fetchImpl.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(seenSignal?.aborted).toBe(false);
    online = false;
    controller.handleOffline();
    expect(seenSignal.aborted).toBe(true);
  });

  it("probes at the slowest tier while the tab is hidden and soon after it becomes visible", async () => {
    visible = false;
    const { controller, probe } = setup({ variantBodies: [OFFLINE], random: () => 0 });
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(STREAM_PROBE_MAX_MS / 2 - 1);
    expect(probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    visible = true;
    controller.handleVisible();
    await vi.advanceTimersByTimeAsync(0); // random 0: probe right away
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("probes right away when the backend reports the stream live again", async () => {
    const { controller, probe } = setup({ variantBodies: [OFFLINE] });
    controller.streamWentOffline({ tailExhausted: true });
    controller.probeSoon(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("reattaches on an access failure so the rebuilt player can renew access", async () => {
    const { controller, onReattach } = setup({ variantBodies: [403] });
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onReattach).toHaveBeenCalledTimes(1);
  });

  it("stops every timer and request on dispose", async () => {
    const { controller, probe, onReattach, fetchImpl } = setup({ variantBodies: [OFFLINE] });
    let seenSignal = null;
    fetchImpl.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    controller.streamWentOffline({ tailExhausted: true });
    await vi.advanceTimersByTimeAsync(1_500);
    controller.dispose();
    expect(seenSignal.aborted).toBe(true);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(onReattach).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.isActive()).toBe(false);
    expect(controller.streamWentOffline({ tailExhausted: true })).toBe(false);
  });

  it("does nothing until an outage starts", async () => {
    const { controller, probe } = setup({ variantBodies: [LIVE] });
    controller.tailExhausted();
    controller.probeSoon(0);
    controller.handleOnline();
    controller.handleVisible();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
    expect(controller.getPhase()).toBe(STREAM_RECONNECT_PHASES.IDLE);
  });
});
