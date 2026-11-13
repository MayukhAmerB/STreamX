// One shared, polled copy of GET /api/realtime/sessions/ per signed-in user and
// query: every component on a page that needs the live-session list reads the
// same store, so a page makes ONE request per interval, and none while hidden.
//
// * Visibility-aware: polling stops while the tab is hidden and refreshes once
//   when it becomes visible again (if the data is older than one interval).
// * Conditional: each poll sends If-None-Match; an unchanged list answers 304
//   with no body and the store keeps what it has.
// * Adaptive: every LIVE_POLL_MS while a session is live, IDLE_POLL_MS
//   otherwise, with jitter so a class does not poll in lockstep, and a bounded
//   backoff while requests fail. A failure keeps the last good list: a blip must
//   not unmount an active broadcast.
import { useSyncExternalStore } from "react";

import { listRealtimeSessionsConditional } from "../../api/realtime";
import { apiData } from "../../utils/api";

export const LIVE_POLL_MS = 15_000;
export const IDLE_POLL_MS = 30_000;
const JITTER_RATIO = 0.1;
const MAX_BACKOFF_MULTIPLIER = 4;

/**
 * status: "idle" (never fetched) | "loading" | "ready" | "error" (no list yet).
 * fetchedAt: time of the last successful response (200 or 304), else 0.
 */
export const EMPTY_LIVE_SESSIONS = Object.freeze({ status: "idle", sessions: [], error: null, fetchedAt: 0 });

function hasLiveSession(sessions) {
  return (Array.isArray(sessions) ? sessions : []).some(
    (session) => String(session?.status || "").toLowerCase() === "live"
  );
}

export function createLiveSessionsStore({
  params = {},
  fetcher = listRealtimeSessionsConditional,
  now = () => Date.now(),
  random = Math.random,
  doc = typeof document === "undefined" ? null : document,
  win = typeof window === "undefined" ? null : window,
  timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) },
} = {}) {
  let state = EMPTY_LIVE_SESSIONS;
  let etag = "";
  let lastAttemptAt = 0;
  let failures = 0;
  let inFlight = null;
  let timer = null;
  const listeners = new Set();

  const emit = () => listeners.forEach((listener) => listener());
  const setState = (next) => {
    state = next;
    emit();
  };
  const visible = () => !doc || doc.visibilityState !== "hidden";

  function intervalMs() {
    const base = hasLiveSession(state.sessions) ? LIVE_POLL_MS : IDLE_POLL_MS;
    return base * Math.min(MAX_BACKOFF_MULTIPLIER, 1 + failures);
  }

  async function refresh() {
    if (inFlight) return inFlight;
    if (state.status === "idle") setState({ ...state, status: "loading" });
    lastAttemptAt = now();
    inFlight = (async () => {
      try {
        const response = await fetcher(params, etag);
        failures = 0;
        if (response?.status === 304) {
          setState({ ...state, status: "ready", error: null, fetchedAt: now() });
          return;
        }
        const rows = apiData(response, null);
        etag = String(response?.headers?.etag || "");
        setState({
          status: "ready",
          sessions: Array.isArray(rows) ? rows : state.sessions,
          error: null,
          fetchedAt: now(),
        });
      } catch (error) {
        failures = Math.min(failures + 1, MAX_BACKOFF_MULTIPLIER);
        // Keep the last good list; only report an error when there is none.
        setState({ ...state, status: state.fetchedAt ? "ready" : "error", error });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule() {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (listeners.size === 0 || !visible()) return;
    const interval = intervalMs();
    const jitter = Math.round((random() * 2 - 1) * interval * JITTER_RATIO);
    const wait = Math.max(1_000, lastAttemptAt + interval + jitter - now());
    timer = timers.set(async () => {
      timer = null;
      if (listeners.size === 0 || !visible()) return;
      await refresh();
      schedule();
    }, wait);
  }

  function refreshIfStale() {
    if (!visible()) {
      schedule(); // clears the timer while hidden
      return;
    }
    if (state.status === "idle" || now() - lastAttemptAt >= intervalMs()) refresh().then(schedule);
    else schedule();
  }

  function onOnline() {
    if (listeners.size && visible()) refresh().then(schedule);
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (listeners.size === 1) {
      doc?.addEventListener?.("visibilitychange", refreshIfStale);
      win?.addEventListener?.("online", onOnline);
      refreshIfStale();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        doc?.removeEventListener?.("visibilitychange", refreshIfStale);
        win?.removeEventListener?.("online", onOnline);
        if (timer !== null) timers.clear(timer);
        timer = null;
      }
    };
  }

  return {
    subscribe,
    getSnapshot: () => state,
    /** Fetch now (e.g. after a join or end action) and restart the interval. */
    refreshNow: () => refresh().then(schedule),
    /** For tests. */
    get listenerCount() {
      return listeners.size;
    },
  };
}

const sharedStores = new Map();

function storeKey(userKey, params) {
  const query = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return `${userKey}|${query}`;
}

/** The page-wide store for this user and query (one poller per page). */
export function getSharedLiveSessionsStore(userKey, params = {}) {
  const key = storeKey(userKey, params);
  let store = sharedStores.get(key);
  if (!store) {
    // Another user's list must never show after a sign-out / sign-in.
    for (const existing of sharedStores.keys()) {
      if (!existing.startsWith(`${userKey}|`)) sharedStores.delete(existing);
    }
    store = createLiveSessionsStore({ params });
    sharedStores.set(key, store);
  }
  return store;
}

const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_LIVE_SESSIONS;

/**
 * `{ status, sessions, error, fetchedAt }` for the signed-in user's active
 * sessions (scheduled and live). Pass `enabled: false` while signed out.
 */
export function useLiveSessions({ enabled = true, userKey = "", params } = {}) {
  const store = enabled && userKey ? getSharedLiveSessionsStore(String(userKey), params) : null;
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
    emptySnapshot
  );
}

export function refreshLiveSessions(userKey, params = {}) {
  if (!userKey) return Promise.resolve();
  return getSharedLiveSessionsStore(String(userKey), params).refreshNow();
}
