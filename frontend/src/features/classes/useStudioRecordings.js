// Recordings of the class open in the studio (moved from the old
// BroadcastingPage without behaviour change): the automatic class recording
// (polled), the latest browser recording, the module override and the admin
// re-run. Recording is automatic: there is no Start/Stop Recording control.
// OWNER: WS-D1.
import { useCallback, useEffect, useState } from "react";
import { deleteRealtimeRecording, listRealtimeRecordings } from "../../api/realtime";
import {
  getRealtimeModuleOptions,
  listSessionClassRecordings,
  rerunClassRecordingFinalize,
  retryClassRecording,
  setClassRecordingModule,
} from "../../api/realtimeLive";
import { hasActiveClassRecording } from "../../components/realtime/ClassRecordingStatus";
import { apiData, apiMessage } from "../../utils/api";
import { canManageSession, resolveRecordingMode } from "./classesModel";

const EMPTY_LATEST = { loading: false, error: "", info: "", active: null, latestCompleted: null, mode: "" };
const EMPTY_CLASS = { sessionId: null, rows: [], loading: false, error: "", retryingId: null };

export default function useStudioRecordings({ session, user }) {
  const sessionId = session?.id ?? null;
  const [latest, setLatest] = useState(EMPTY_LATEST);
  const [classState, setClassState] = useState(EMPTY_CLASS);
  const [refreshKey, setRefreshKey] = useState(0);
  const [moduleOptions, setModuleOptions] = useState([]);
  const [actionId, setActionId] = useState({ module: null, rerun: null });
  const refresh = useCallback(() => setRefreshKey((previous) => previous + 1), []);

  // Latest browser recording (Open / Delete last recording).
  useEffect(() => {
    let active = true;
    if (!sessionId) {
      setLatest(EMPTY_LATEST);
      return undefined;
    }
    (async () => {
      try {
        const rows = apiData(await listRealtimeRecordings(sessionId), []);
        if (!active) return;
        const list = Array.isArray(rows) ? rows : [];
        const activeRecording = list.find((item) => item?.is_active) || null;
        setLatest((prev) => ({
          ...prev,
          loading: false,
          error: "",
          active: activeRecording,
          latestCompleted: list.find((item) => item?.status === "completed") || null,
          mode: resolveRecordingMode(activeRecording),
        }));
      } catch {
        if (active) setLatest((prev) => ({ ...prev, loading: false }));
      }
    })();
    return () => {
      active = false;
    };
  }, [sessionId]);

  // The automatic class recording: follow it closely while it is being saved, lazily otherwise.
  useEffect(() => {
    if (!sessionId) {
      setClassState(EMPTY_CLASS);
      return undefined;
    }
    let cancelled = false;
    let timerId = null;
    const poll = async () => {
      try {
        const rows = await listSessionClassRecordings(sessionId);
        if (cancelled) return;
        setClassState((prev) => ({ ...prev, sessionId, rows, loading: false, error: "" }));
        timerId = window.setTimeout(poll, hasActiveClassRecording(rows) ? 5000 : 30000);
      } catch (err) {
        if (cancelled) return;
        setClassState((prev) => ({ ...prev, sessionId, loading: false, error: apiMessage(err, "Unable to load class recordings.") }));
        timerId = window.setTimeout(poll, 30000);
      }
    };
    setClassState((prev) => (prev.sessionId === sessionId ? { ...prev, loading: true } : { ...EMPTY_CLASS, sessionId, loading: true }));
    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [sessionId, refreshKey]);

  // Phase 2: modules of the class's course for the optional module override.
  const liveClassId = session?.linked_live_class?.id || null;
  const manage = canManageSession(session, user);
  useEffect(() => {
    if (!liveClassId || !manage) {
      setModuleOptions([]);
      return undefined;
    }
    let cancelled = false;
    getRealtimeModuleOptions({ live_class_id: Number(liveClassId) })
      .then((options) => {
        if (!cancelled) setModuleOptions(Array.isArray(options?.modules) ? options.modules : []);
      })
      .catch(() => {
        if (!cancelled) setModuleOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [liveClassId, manage]);

  const changeModule = async (recording, moduleId) => {
    setActionId((prev) => ({ ...prev, module: recording.id }));
    setClassState((prev) => ({ ...prev, error: "" }));
    try {
      await setClassRecordingModule(recording.id, moduleId);
      refresh();
    } catch (err) {
      setClassState((prev) => ({ ...prev, error: apiMessage(err, "Unable to change the module.") }));
    } finally {
      setActionId((prev) => ({ ...prev, module: null }));
    }
  };

  const rerun = async (recording) => {
    setActionId((prev) => ({ ...prev, rerun: recording.id }));
    setClassState((prev) => ({ ...prev, error: "" }));
    try {
      await rerunClassRecordingFinalize(recording.id);
      refresh();
    } catch (err) {
      setClassState((prev) => ({ ...prev, error: apiMessage(err, "Unable to re-run the recording.") }));
    } finally {
      setActionId((prev) => ({ ...prev, rerun: null }));
    }
  };

  const retry = async (recording) => {
    setClassState((prev) => ({ ...prev, retryingId: recording.id, error: "" }));
    try {
      await retryClassRecording(recording.id);
      setClassState((prev) => ({ ...prev, retryingId: null }));
      refresh();
    } catch (err) {
      setClassState((prev) => ({ ...prev, retryingId: null, error: apiMessage(err, "Unable to retry the class recording.") }));
    }
  };

  const deleteLatest = async () => {
    const target = latest.latestCompleted;
    if (!sessionId || !target?.id) return;
    setLatest((prev) => ({ ...prev, loading: true, error: "", info: "" }));
    try {
      await deleteRealtimeRecording(target.id);
      setLatest((prev) => ({
        ...prev,
        loading: false,
        error: "",
        info: "Latest broadcast recording deleted.",
        active: prev.active?.id === target.id ? null : prev.active,
        latestCompleted: prev.latestCompleted?.id === target.id ? null : prev.latestCompleted,
      }));
    } catch (err) {
      setLatest((prev) => ({ ...prev, loading: false, error: apiMessage(err, "Unable to delete broadcast recording."), info: "" }));
    }
  };

  return {
    latest,
    classRecordings: classState.sessionId === sessionId ? classState.rows : [],
    classState,
    moduleOptions,
    actionId,
    refresh,
    changeModule: manage ? changeModule : undefined,
    rerun,
    retry,
    deleteLatest,
  };
}
