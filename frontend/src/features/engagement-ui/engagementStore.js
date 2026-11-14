// Engagement read model for the signed-in viewer (framework-free; React
// subscribes through useEngagement). OWNER: WS-LEARN (console-student).
//
// Contract rules (engagement-notes.md §9), enforced here:
//   - fetch /me on first use and on window focus;
//   - while the tab is visible, re-validate at most every 5 minutes, always
//     with If-None-Match (a 304 is "unchanged");
//   - an `X-Engagement` header (lecture completed, report submitted) updates
//     XP, level and streak optimistically (xp + pending_xp) without a fetch;
//   - 403 feature_disabled: status "disabled", nothing is shown or retried
//     until capabilities say the switch is on again.
import {
  fetchEngagementMe,
  isEngagementDisabledError,
  watchEngagementHeader,
} from "./engagementApi";

export const REVALIDATE_MS = 5 * 60 * 1000;
export const FOCUS_MIN_GAP_MS = 15 * 1000;

const INITIAL = Object.freeze({
  status: "idle",
  data: null,
  etag: "",
  fetchedAt: 0,
  error: null,
  optimistic: null,
  gain: null,
});

/**
 * `deps` (tests): { api: { fetchMe }, now: () => ms, win: window-like, doc: document-like, watchHeader }.
 */
export function createEngagementStore(deps = {}) {
  const api = deps.api || { fetchMe: fetchEngagementMe };
  const now = deps.now || (() => Date.now());
  const win = deps.win !== undefined ? deps.win : typeof window !== "undefined" ? window : null;
  const doc = deps.doc !== undefined ? deps.doc : typeof document !== "undefined" ? document : null;
  const watchHeader = deps.watchHeader || watchEngagementHeader;

  let state = INITIAL;
  let inFlight = null;
  let owner = null;
  let users = 0;
  let timer = null;
  let gainSeq = 0;
  const listeners = new Set();

  const set = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };

  const visible = () => !doc || doc.visibilityState !== "hidden";

  async function refresh({ force = false } = {}) {
    if (state.status === "disabled" && !force) return state;
    if (inFlight) return inFlight;
    const etag = force ? "" : state.etag;
    if (!state.data) set({ status: "loading", error: null });
    const ownerAtStart = owner;
    inFlight = api
      .fetchMe({ etag })
      .then((result) => {
        if (ownerAtStart !== owner) return state;
        if (result.status === 304 && state.data) {
          set({ status: "ready", fetchedAt: now(), error: null });
          return state;
        }
        const data = result.data || null;
        const optimistic = state.optimistic && data && Number(data.version) >= state.optimistic.version ? null : state.optimistic;
        set({ status: data ? "ready" : "error", data, etag: result.etag || "", fetchedAt: now(), error: null, optimistic });
        return state;
      })
      .catch((error) => {
        if (ownerAtStart !== owner) return state;
        if (isEngagementDisabledError(error)) {
          set({ ...INITIAL, status: "disabled" });
        } else {
          set({ status: state.data ? "ready" : "error", error, fetchedAt: now() });
        }
        return state;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function revalidateIfStale(minGap) {
    if (!visible()) return;
    if (state.status === "disabled") return;
    if (now() - state.fetchedAt < minGap) return;
    refresh();
  }

  const onFocus = () => revalidateIfStale(FOCUS_MIN_GAP_MS);
  const onVisibility = () => {
    if (visible()) revalidateIfStale(FOCUS_MIN_GAP_MS);
  };

  function applyHeader(header) {
    if (!header || users === 0) return;
    const knownVersion = Math.max(Number(state.data?.version) || 0, state.optimistic?.version || 0);
    if (header.version && header.version <= knownVersion) return;
    const baseXp = header.xp ?? state.data?.xp ?? 0;
    const optimistic = {
      version: header.version || knownVersion + 1,
      xp: baseXp + header.pendingXp,
      level: header.level || state.data?.level || null,
      streak: header.streak ? { ...(state.data?.streak || {}), ...header.streak } : state.data?.streak || null,
    };
    gainSeq += 1;
    set({ optimistic, gain: header.pendingXp > 0 ? { id: gainSeq, xp: header.pendingXp, at: now() } : state.gain });
  }

  /** One consumer mounted (refcounted): loads, then listens for focus and the 5 min tick. */
  function start(userId) {
    if (owner !== userId) {
      owner = userId;
      state = INITIAL;
      inFlight = null;
    }
    users += 1;
    if (users === 1) {
      watchHeader((header) => applyHeader(header));
      win?.addEventListener?.("focus", onFocus);
      doc?.addEventListener?.("visibilitychange", onVisibility);
      if (win?.setInterval) timer = win.setInterval(() => revalidateIfStale(REVALIDATE_MS - 1000), REVALIDATE_MS);
    }
    if (state.status === "idle" || (state.status === "error" && !inFlight)) refresh();
    return stop;
  }

  function stop() {
    users = Math.max(0, users - 1);
    if (users > 0) return;
    win?.removeEventListener?.("focus", onFocus);
    doc?.removeEventListener?.("visibilitychange", onVisibility);
    if (timer !== null) {
      win?.clearInterval?.(timer);
      timer = null;
    }
  }

  /** The switch came back on (capabilities): allow fetching again. */
  function reenable() {
    if (state.status === "disabled") {
      state = INITIAL;
      if (users > 0) refresh();
      else listeners.forEach((listener) => listener());
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    start,
    stop,
    reenable,
    applyHeader,
    clearGain: () => set({ gain: null }),
  };
}

/** XP, level and streak to display: server values, or the optimistic header values when newer. */
export function selectSummary(state) {
  const data = state?.data;
  if (!data) return null;
  const optimistic = state.optimistic;
  if (!optimistic || optimistic.version <= (Number(data.version) || 0)) {
    return { xp: data.xp, level: data.level, streak: data.streak, pending: false };
  }
  return {
    xp: Math.max(data.xp || 0, optimistic.xp || 0),
    level: optimistic.level || data.level,
    streak: optimistic.streak || data.streak,
    pending: true,
  };
}

export const engagementStore = createEngagementStore();
