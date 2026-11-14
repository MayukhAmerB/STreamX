// Load-and-refresh hook for Admin pages. OWNER: WS-G.
// Keeps the last good data on screen when a refresh fails (with the time it
// was loaded), ignores answers that arrive out of order, and can poll while
// the tab is visible (paused when hidden, refreshed on return).
import { useCallback, useEffect, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";

export default function useAdminData(load, { deps = [], pollMs = 0, initial = null } = {}) {
  const [state, setState] = useState({ data: initial, error: "", loading: true, lastUpdated: null });
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(({ quiet = false } = {}) => {
    const mine = ++seq.current;
    if (!quiet) setState((current) => ({ ...current, loading: true, error: "" }));
    return Promise.resolve()
      .then(() => loadRef.current())
      .then((response) => {
        if (seq.current !== mine) return;
        setState({ data: apiData(response, null), error: "", loading: false, lastUpdated: new Date() });
      })
      .catch((error) => {
        if (seq.current !== mine) return;
        setState((current) => ({ ...current, loading: false, error: apiMessage(error, "This could not be loaded.") }));
      });
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (!pollMs || typeof document === "undefined") return undefined;
    let timer = null;
    const start = () => {
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (!document.hidden) reload({ quiet: true });
      }, pollMs);
    };
    const onVisible = () => {
      if (!document.hidden) {
        reload({ quiet: true });
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs, reload]);

  const setData = useCallback((update) => {
    setState((current) => ({ ...current, data: typeof update === "function" ? update(current.data) : update }));
  }, []);

  return { ...state, reload, setData };
}
