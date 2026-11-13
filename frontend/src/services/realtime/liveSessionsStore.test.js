import { describe, expect, it, vi } from "vitest";

import { createLiveSessionsStore, IDLE_POLL_MS, LIVE_POLL_MS } from "./liveSessionsStore";

const live = { id: 1, status: "live" };
const scheduled = { id: 2, status: "scheduled" };

function ok(rows, etag = 'W/"a"') {
  return { status: 200, headers: { etag }, data: { success: true, data: rows } };
}
const notModified = { status: 304, headers: {}, data: "" };

function harness({ responses = [ok([scheduled])] } = {}) {
  let clock = 1_000_000;
  const scheduledTimers = new Map();
  let nextId = 1;
  const listeners = new Map();
  const doc = {
    visibilityState: "visible",
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const winListeners = new Map();
  const win = {
    addEventListener: (type, fn) => winListeners.set(type, fn),
    removeEventListener: (type) => winListeners.delete(type),
  };
  const queue = [...responses];
  const fetcher = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
  const store = createLiveSessionsStore({
    fetcher,
    now: () => clock,
    random: () => 0.5, // no jitter
    doc,
    win,
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        scheduledTimers.set(id, { fn, at: clock + ms });
        return id;
      },
      clear: (id) => scheduledTimers.delete(id),
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    store,
    fetcher,
    scheduledTimers,
    winListeners,
    flush,
    async advance(ms) {
      clock += ms;
      for (const [id, task] of [...scheduledTimers]) {
        if (task.at <= clock) {
          scheduledTimers.delete(id);
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

describe("shared live-sessions store", () => {
  it("makes one request for every subscriber on the page", async () => {
    const h = harness();
    const stopA = h.store.subscribe(() => {});
    const stopB = h.store.subscribe(() => {});
    await h.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(h.store.getSnapshot()).toMatchObject({ status: "ready", sessions: [scheduled] });
    stopA();
    stopB();
    expect(h.store.listenerCount).toBe(0);
    expect(h.scheduledTimers.size).toBe(0);
  });

  it("polls slowly when nothing is live and faster while a class is live", async () => {
    const h = harness({ responses: [ok([scheduled]), ok([live], 'W/"b"')] });
    h.store.subscribe(() => {});
    await h.flush();
    await h.advance(IDLE_POLL_MS - 1_000);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await h.advance(1_000);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await h.advance(LIVE_POLL_MS);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });

  it("sends the last ETag and keeps its list on 304", async () => {
    const h = harness({ responses: [ok([live], 'W/"v1"'), notModified] });
    h.store.subscribe(() => {});
    await h.flush();
    const first = h.store.getSnapshot();
    await h.advance(LIVE_POLL_MS);
    expect(h.fetcher).toHaveBeenLastCalledWith({}, 'W/"v1"');
    const second = h.store.getSnapshot();
    expect(second.sessions).toBe(first.sessions);
    expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt);
  });

  it("pauses while the tab is hidden and refreshes when it is visible again", async () => {
    const h = harness();
    h.store.subscribe(() => {});
    await h.flush();
    await h.setVisibility("hidden");
    expect(h.scheduledTimers.size).toBe(0);
    await h.advance(IDLE_POLL_MS * 5);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await h.setVisibility("visible");
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good list through failures and backs off", async () => {
    const h = harness({ responses: [ok([live]), new Error("offline"), new Error("offline"), ok([live])] });
    h.store.subscribe(() => {});
    await h.flush();
    await h.advance(LIVE_POLL_MS);
    expect(h.store.getSnapshot()).toMatchObject({ status: "ready", sessions: [live] });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await h.advance(LIVE_POLL_MS);
    expect(h.fetcher).toHaveBeenCalledTimes(2); // backed off to 2x
    await h.advance(LIVE_POLL_MS);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });

  it("reports an error only when it never had a list", async () => {
    const h = harness({ responses: [new Error("down")] });
    h.store.subscribe(() => {});
    await h.flush();
    expect(h.store.getSnapshot().status).toBe("error");
    expect(h.store.getSnapshot().sessions).toEqual([]);
  });

  it("refreshes right away when the browser comes back online", async () => {
    const h = harness();
    h.store.subscribe(() => {});
    await h.flush();
    h.winListeners.get("online")?.();
    await h.flush();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
});
