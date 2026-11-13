// One shared, polled copy of GET /api/site/youtube/ for the whole website:
// the navbar's live dot, the landing section and the Watch page all read it,
// so a page makes at most one request a minute, and none while hidden.
import { useSyncExternalStore } from "react";

import { getYouTubeChannel } from "../../api/siteMedia";
import { siteBrand } from "../../config/siteBrand";
import { apiData } from "../../utils/api";
import { normalizeYouTubePayload } from "./youtubeModel";

export const YOUTUBE_POLL_MS = 60_000;

/**
 * status: "idle" (never fetched) | "loading" | "ready" (model may be null = hidden).
 * enabled: false only once the server said the section is switched off.
 */
const EMPTY = Object.freeze({ status: "idle", model: null, enabled: true });

export function createYouTubeStore({
  fetcher = getYouTubeChannel,
  enabled = siteBrand.youtube,
  pollMs = YOUTUBE_POLL_MS,
  now = () => Date.now(),
  doc = typeof document === "undefined" ? null : document,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
} = {}) {
  let state = EMPTY;
  let lastFetchAt = 0;
  let inFlight = null;
  let timer = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener());
  const setState = (next) => {
    state = next;
    emit();
  };
  const visible = () => !doc || doc.visibilityState !== "hidden";

  async function refresh() {
    if (!enabled) return Promise.resolve();
    if (inFlight) return inFlight;
    if (state.status === "idle") setState({ status: "loading", model: null, enabled: true });
    lastFetchAt = now();
    inFlight = (async () => {
      try {
        const response = await fetcher();
        const data = apiData(response, null);
        setState({ status: "ready", model: normalizeYouTubePayload(data), enabled: data?.enabled !== false });
      } catch {
        // Fail soft: keep showing what we had; hide the section if we never had anything.
        setState({ status: "ready", model: state.model, enabled: state.enabled });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule() {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (!enabled || listeners.size === 0 || !visible()) return;
    const wait = Math.max(0, lastFetchAt + pollMs - now());
    timer = timers.set(async () => {
      timer = null;
      if (listeners.size === 0 || !visible()) return;
      await refresh();
      schedule();
    }, wait);
  }

  function onVisibilityChange() {
    if (!visible()) {
      schedule(); // clears the timer
      return;
    }
    if (now() - lastFetchAt >= pollMs) refresh().then(schedule);
    else schedule();
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (listeners.size === 1) {
      doc?.addEventListener?.("visibilitychange", onVisibilityChange);
      if (enabled && (state.status === "idle" || now() - lastFetchAt >= pollMs) && visible()) {
        refresh().then(schedule);
      } else {
        schedule();
      }
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        doc?.removeEventListener?.("visibilitychange", onVisibilityChange);
        if (timer !== null) timers.clear(timer);
        timer = null;
      }
    };
  }

  return {
    subscribe,
    getSnapshot: () => state,
    refresh,
    /** For tests. */
    get listenerCount() {
      return listeners.size;
    },
  };
}

let sharedStore = null;

export function getSharedYouTubeStore() {
  if (!sharedStore) sharedStore = createYouTubeStore();
  return sharedStore;
}

/** `{ status, model, enabled }`; `model` is null while loading, when disabled, or when unavailable. */
export function useYouTubeChannel(store = getSharedYouTubeStore()) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);
}
