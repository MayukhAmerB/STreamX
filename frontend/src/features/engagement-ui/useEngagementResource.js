// One engagement read (badges, achievements, leaderboard) with ETag
// re-validation. OWNER: WS-LEARN.
//
// `pollMs` re-validates at most that often and only while the tab is visible
// (the leaderboard uses 60 s, as the contract allows); 0 means "load once".
import { useCallback, useEffect, useRef, useState } from "react";
import { apiMessage } from "../../utils/api";
import { isEngagementDisabledError } from "./engagementApi";

export default function useEngagementResource(fetcher, { enabled = true, pollMs = 0, key = "" } = {}) {
  const [state, setState] = useState({ status: enabled ? "loading" : "off", data: null, error: "" });
  const etagRef = useRef("");
  const keyRef = useRef(key);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(
    async ({ conditional = true } = {}) => {
      const requestKey = keyRef.current;
      try {
        const result = await fetcherRef.current({ etag: conditional ? etagRef.current : "" });
        if (requestKey !== keyRef.current) return;
        if (result.status === 304) {
          setState((previous) => (previous.data ? { ...previous, status: "ready", error: "" } : previous));
          return;
        }
        etagRef.current = result.etag || "";
        setState({ status: "ready", data: result.data, error: "" });
      } catch (error) {
        if (requestKey !== keyRef.current) return;
        if (isEngagementDisabledError(error)) {
          setState({ status: "disabled", data: null, error: "" });
          return;
        }
        setState((previous) => ({
          status: previous.data ? "ready" : "error",
          data: previous.data,
          error: apiMessage(error, "This could not be loaded."),
        }));
      }
    },
    []
  );

  useEffect(() => {
    keyRef.current = key;
    etagRef.current = "";
    if (!enabled) {
      setState({ status: "off", data: null, error: "" });
      return undefined;
    }
    setState((previous) => ({ status: "loading", data: previous.data, error: "" }));
    load({ conditional: false });
    if (!pollMs || typeof window === "undefined") return undefined;
    let last = Date.now();
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // Never more often than pollMs, whether the trigger is the timer or focus.
      if (Date.now() - last < pollMs - 1000) return;
      last = Date.now();
      load();
    };
    const timer = window.setInterval(tick, pollMs);
    const onFocus = () => tick();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, key, load, pollMs]);

  return { ...state, reload: () => load({ conditional: false }) };
}
