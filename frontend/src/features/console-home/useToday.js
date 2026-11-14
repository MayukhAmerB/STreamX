// Loads /api/console/today/ for one workspace. OWNER: WS-C.
//
// - The skeleton shows only after 300 ms (no flash on fast loads) and stays at
//   least 250 ms once shown (no flicker): plan §2.2 skeleton tokens, M3.
// - Refreshes every minute while the tab is visible (a class going live moves
//   to the top of Home) and when the tab becomes visible again.
// - On a failed refresh the last data stays on screen with "Last updated".
import { useCallback, useEffect, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { getToday } from "./todayApi";

const SKELETON_DELAY_MS = 300;
const SKELETON_MIN_MS = 250;
const REFRESH_MS = 60_000;

export default function useToday(workspace = "learn", { refreshMs = REFRESH_MS } = {}) {
  const [state, setState] = useState({ data: null, error: null, errorCode: "", loading: true, updatedAt: null });
  const [showSkeleton, setShowSkeleton] = useState(false);
  const skeletonShownAt = useRef(0);
  const active = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await getToday(workspace);
      const data = apiData(response, null);
      if (active.current) setState({ data, error: null, errorCode: "", loading: false, updatedAt: Date.now() });
    } catch (err) {
      if (active.current) {
        setState((previous) => ({
          ...previous,
          loading: false,
          error: apiMessage(err, "Please check your connection and try again."),
          errorCode: String(err?.response?.data?.code || ""),
        }));
      }
    }
  }, [workspace]);

  useEffect(() => {
    active.current = true;
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") load();
    }, refreshMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, refreshMs]);

  // Delayed skeleton with a minimum visible time.
  useEffect(() => {
    if (state.loading) {
      const timer = window.setTimeout(() => {
        skeletonShownAt.current = Date.now();
        setShowSkeleton(true);
      }, SKELETON_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (!showSkeleton) return undefined;
    const left = Math.max(0, SKELETON_MIN_MS - (Date.now() - skeletonShownAt.current));
    const timer = window.setTimeout(() => setShowSkeleton(false), left);
    return () => window.clearTimeout(timer);
  }, [state.loading, showSkeleton]);

  const retry = useCallback(() => {
    setState((previous) => ({ ...previous, loading: previous.data == null, error: null }));
    load();
  }, [load]);

  return {
    data: state.data,
    error: state.error,
    errorCode: state.errorCode,
    // While the skeleton is held for its minimum time, keep showing it.
    loading: (state.loading || showSkeleton) && state.data == null,
    showSkeleton,
    updatedAt: state.updatedAt,
    retry,
  };
}
