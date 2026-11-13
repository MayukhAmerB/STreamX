import { describe, expect, it, vi } from "vitest";

import { createYouTubeStore, YOUTUBE_POLL_MS } from "./youTubeStore";
import { livePayload, payload } from "./youtubeFixtures";

function harness({ responses = [payload()], enabled = true } = {}) {
  let clock = 1_000_000;
  const scheduled = new Map();
  let nextId = 1;
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const queue = [...responses];
  const fetcher = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { data: { success: true, data: next } };
  });
  const store = createYouTubeStore({
    fetcher,
    enabled,
    now: () => clock,
    doc,
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        scheduled.set(id, { fn, at: clock + ms });
        return id;
      },
      clear: (id) => scheduled.delete(id),
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    fetcher,
    doc,
    scheduled,
    flush,
    async advance(ms) {
      clock += ms;
      for (const [id, task] of [...scheduled]) {
        if (task.at <= clock) {
          scheduled.delete(id);
          await task.fn();
        }
      }
      await flush();
    },
    async setVisibility(state) {
      doc.visibilityState = state;
      listeners.get("visibilitychange")?.();
      await flush();
    },
  };
}

describe("YouTube store", () => {
  it("fetches once for every subscriber and polls at most once a minute", async () => {
    const h = harness();
    const stopA = h.store.subscribe(() => {});
    const stopB = h.store.subscribe(() => {});
    await h.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot().model.featured.videoId).toBe("hWFA4oNF7gk");

    await h.advance(YOUTUBE_POLL_MS - 1000);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await h.advance(1000);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    stopA();
    stopB();
    expect(h.scheduled.size).toBe(0);
  });

  it("does not poll while the tab is hidden and catches up when it is visible again", async () => {
    const h = harness({ responses: [payload(), livePayload()] });
    const stop = h.store.subscribe(() => {});
    await h.flush();
    await h.setVisibility("hidden");
    expect(h.scheduled.size).toBe(0);
    await h.advance(5 * YOUTUBE_POLL_MS);
    expect(h.fetcher).toHaveBeenCalledTimes(1);

    await h.setVisibility("visible");
    await h.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.store.getSnapshot().model.live.videoId).toBe("LiVe1234567");
    stop();
  });

  it("keeps the last good data when a refresh fails", async () => {
    const h = harness({ responses: [payload(), new Error("offline")] });
    const stop = h.store.subscribe(() => {});
    await h.flush();
    await h.advance(YOUTUBE_POLL_MS);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.store.getSnapshot().model.featured.videoId).toBe("hWFA4oNF7gk");
    stop();
  });

  it("remembers that the server switched the section off", async () => {
    const h = harness({ responses: [payload({ enabled: false, available: false })] });
    const stop = h.store.subscribe(() => {});
    await h.flush();
    expect(h.store.getSnapshot()).toMatchObject({ status: "ready", model: null, enabled: false });
    stop();
  });

  it("never fetches for a brand without the channel", async () => {
    const h = harness({ enabled: false });
    const stop = h.store.subscribe(() => {});
    await h.flush();
    await h.setVisibility("visible");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.store.getSnapshot().status).toBe("idle");
    stop();
  });
});
