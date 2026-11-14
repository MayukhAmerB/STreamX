// Small live hints for the Learn nav (plan §3.2): a red dot on "Live
// classes" only while a class the viewer can join is on air, a badge on
// "Coursework" while a report is due or an exam is open, and whether any
// guides exist (the Guides item hides while there are none). OWNER: WS-B.
//
// One shared, cached read of GET /api/console/today/?workspace=learn (the
// same request Home makes) at most once a minute, refreshed when the tab
// becomes visible again after 5 minutes. Failures are silent: no hint.
import { useEffect, useState } from "react";
import { listGuides } from "../../api/guides";
import apiClient from "../../api/client";
import { apiData } from "../../utils/api";

const TODAY_TTL_MS = 60_000;
const REFRESH_AFTER_MS = 5 * 60_000;

const cache = { userId: null, at: 0, promise: null, signals: null, guides: null, guidesPromise: null };

/** Pure: today payload (Appendix A.2) → `{ live, coursework }`. */
export function signalsFromToday(today) {
  const rows = [today?.next_up, ...(Array.isArray(today?.also) ? today.also : [])].filter(Boolean);
  const kinds = new Set(rows.map((row) => row.kind));
  return {
    live: kinds.has("live_now"),
    coursework: kinds.has("report_due") || kinds.has("exam_open"),
  };
}

/** Pure: guides list response → true when at least one guide exists, null when unknown. */
export function guidesAvailableFrom(data) {
  if (Array.isArray(data)) return data.length > 0;
  if (Array.isArray(data?.results)) return data.results.length > 0;
  if (typeof data?.count === "number") return data.count > 0;
  return null;
}

function loadToday(userId, force = false) {
  if (cache.userId !== userId) {
    Object.assign(cache, { userId, at: 0, promise: null, signals: null, guides: null, guidesPromise: null });
  }
  const fresh = Date.now() - cache.at < TODAY_TTL_MS;
  if (cache.promise && (fresh || !force)) return cache.promise;
  cache.at = Date.now();
  cache.promise = apiClient
    .get("/console/today/", { params: { workspace: "learn" } })
    .then((response) => {
      cache.signals = signalsFromToday(apiData(response, null));
      return cache.signals;
    })
    .catch(() => {
      cache.signals = null;
      return null;
    });
  return cache.promise;
}

function loadGuides() {
  if (!cache.guidesPromise) {
    cache.guidesPromise = listGuides()
      .then((response) => {
        cache.guides = guidesAvailableFrom(apiData(response, null));
        return cache.guides;
      })
      .catch(() => null);
  }
  return cache.guidesPromise;
}

/** `{ live, coursework, guidesAvailable }` for the Learn workspace (all false/unknown elsewhere). */
export function useNavSignals({ userId = null, enabled = true } = {}) {
  const [state, setState] = useState(() => ({
    signals: cache.userId === userId ? cache.signals : null,
    guides: cache.userId === userId ? cache.guides : null,
  }));

  useEffect(() => {
    if (!enabled || userId == null || typeof window === "undefined") return undefined;
    let active = true;
    const update = (patch) => {
      if (active) setState((previous) => ({ ...previous, ...patch }));
    };
    loadToday(userId).then((signals) => update({ signals }));
    loadGuides().then((guides) => update({ guides }));
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - cache.at < REFRESH_AFTER_MS) return;
      loadToday(userId, true).then((signals) => update({ signals }));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, userId]);

  return {
    live: Boolean(enabled && state.signals?.live),
    coursework: Boolean(enabled && state.signals?.coursework),
    guidesAvailable: state.guides !== false,
  };
}
