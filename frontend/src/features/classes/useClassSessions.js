// Loads the classes the Classes page lists (meetings and broadcasts that
// have not ended) and the live classes a new class can link to. OWNER: WS-D1.
import { useCallback, useEffect, useState } from "react";
import { listLiveClasses } from "../../api/courses";
import { listRealtimeSessions } from "../../api/realtime";
import { apiData, apiMessage } from "../../utils/api";
import { activeClassSessions, sortLiveClassOptions } from "./classesModel";

export function useClassSessions() {
  const [state, setState] = useState({ rows: [], loading: true, error: "", loadedAt: 0 });

  const reload = useCallback(async () => {
    try {
      const response = await listRealtimeSessions({ status: "all" });
      setState({ rows: activeClassSessions(apiData(response, [])), loading: false, error: "", loadedAt: Date.now() });
    } catch (err) {
      setState((current) => ({ ...current, loading: false, error: apiMessage(err, "Unable to load your classes.") }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const replaceRow = useCallback((updated) => {
    if (!updated?.id) return;
    setState((current) => ({ ...current, rows: current.rows.map((row) => (row.id === updated.id ? updated : row)) }));
  }, []);

  const removeRow = useCallback((id) => {
    setState((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== id) }));
  }, []);

  const addRow = useCallback((created) => {
    if (!created?.id) return;
    setState((current) => ({ ...current, rows: [created, ...current.rows.filter((row) => row.id !== created.id)] }));
  }, []);

  return { ...state, reload, replaceRow, removeRow, addRow };
}

export function useLiveClassOptions(enabled = true) {
  const [options, setOptions] = useState({ items: [], loading: true });
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    (async () => {
      try {
        const payload = apiData(await listLiveClasses(), []);
        const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
        if (active) setOptions({ items: sortLiveClassOptions(rows), loading: false });
      } catch {
        if (active) setOptions({ items: [], loading: false });
      }
    })();
    return () => {
      active = false;
    };
  }, [enabled]);
  return options;
}
