// "Host a class" form state: one flow for both modes (plan §3.5). The
// payloads are exactly the ones the old Meeting and Broadcasting pages sent.
// OWNER: WS-D1.
import { useCallback, useEffect, useState } from "react";
import { createRealtimeSession } from "../../api/realtime";
import { getRealtimeModuleOptions } from "../../api/realtimeLive";
import { apiData, apiMessage } from "../../utils/api";
import {
  MODE_BROADCAST,
  MODE_MEETING,
  STREAM_SERVICE_ALSYED,
  STREAM_SERVICE_OBS,
  inferObsServerUrl,
} from "./classesModel";

export const initialHostClassForm = Object.freeze({
  mode: MODE_BROADCAST,
  title: "",
  description: "",
  linked_live_class_id: "",
  target_module_id: "",
  stream_service: STREAM_SERVICE_ALSYED,
  obs_stream_server_url: "",
  stream_embed_url: "",
  chat_embed_url: "",
  rtmp_target_url: "",
  meeting_capacity: 200,
});

const EMPTY_MODULES = { liveClassId: "", loading: false, error: "", course: null, modules: [] };

/** The POST /realtime/sessions/ body for a form (pure; tested). */
export function hostClassPayload(form) {
  if (form.mode === MODE_MEETING) {
    return {
      title: form.title,
      description: form.description,
      linked_live_class_id: Number(form.linked_live_class_id),
      session_type: "meeting",
      meeting_capacity: Number(form.meeting_capacity || 200),
      allow_overflow_broadcast: true,
      max_audience: 500,
    };
  }
  const browser = form.stream_service === STREAM_SERVICE_ALSYED;
  return {
    title: form.title,
    description: form.description,
    linked_live_class_id: Number(form.linked_live_class_id),
    target_module_id: form.target_module_id ? Number(form.target_module_id) : null,
    session_type: "broadcasting",
    stream_service: form.stream_service,
    obs_stream_key: "",
    meeting_capacity: 200,
    max_audience: 500,
    allow_overflow_broadcast: true,
    stream_embed_url: browser ? form.stream_embed_url : "",
    chat_embed_url: browser ? form.chat_embed_url : "",
    rtmp_target_url: browser ? form.rtmp_target_url : form.obs_stream_server_url,
  };
}

export default function useHostClassForm({ initialMode = MODE_BROADCAST, onCreated } = {}) {
  const [form, setForm] = useState(() => ({ ...initialHostClassForm, mode: initialMode }));
  const [moduleOptions, setModuleOptions] = useState(EMPTY_MODULES);
  const [submit, setSubmit] = useState({ loading: false, error: "" });

  const update = useCallback((patch) => setForm((current) => ({ ...current, ...patch })), []);

  const setStreamService = useCallback((service) => {
    setForm((current) =>
      service === STREAM_SERVICE_OBS
        ? { ...current, stream_service: service, obs_stream_server_url: current.obs_stream_server_url || inferObsServerUrl() }
        : { ...current, stream_service: service }
    );
  }, []);

  const reset = useCallback((mode = initialMode) => {
    setForm({ ...initialHostClassForm, mode });
    setSubmit({ loading: false, error: "" });
  }, [initialMode]);

  // Modules of the chosen live class's course (optional recording target).
  useEffect(() => {
    const liveClassId = String(form.linked_live_class_id || "");
    if (!liveClassId || form.mode !== MODE_BROADCAST) {
      setModuleOptions(EMPTY_MODULES);
      return undefined;
    }
    let cancelled = false;
    setModuleOptions({ ...EMPTY_MODULES, liveClassId, loading: true });
    getRealtimeModuleOptions({ live_class_id: Number(liveClassId) })
      .then((options) => {
        if (cancelled) return;
        setModuleOptions({
          liveClassId,
          loading: false,
          error: "",
          course: options?.course || null,
          modules: Array.isArray(options?.modules) ? options.modules : [],
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setModuleOptions({ ...EMPTY_MODULES, liveClassId, error: apiMessage(err, "Unable to load the course modules.") });
      });
    return () => {
      cancelled = true;
    };
  }, [form.linked_live_class_id, form.mode]);

  const handleSubmit = async (event) => {
    event?.preventDefault?.();
    if (!form.linked_live_class_id) {
      setSubmit({ loading: false, error: `Select the linked live class for this ${form.mode === MODE_MEETING ? "meeting" : "broadcast"}.` });
      return null;
    }
    if (!String(form.title || "").trim()) {
      setSubmit({ loading: false, error: "Give the class a title." });
      return null;
    }
    if (form.mode === MODE_BROADCAST && moduleOptions.loading) {
      setSubmit({ loading: false, error: "Course modules are still loading. Try again in a moment." });
      return null;
    }
    setSubmit({ loading: true, error: "" });
    try {
      const created = apiData(await createRealtimeSession(hostClassPayload(form)), null);
      setSubmit({ loading: false, error: "" });
      const mode = form.mode;
      setForm({ ...initialHostClassForm, mode });
      if (created) await onCreated?.(created, mode);
      return created;
    } catch (err) {
      setSubmit({
        loading: false,
        error: apiMessage(err, form.mode === MODE_MEETING ? "Unable to create meeting." : "Unable to create broadcast."),
      });
      return null;
    }
  };

  return { form, update, setStreamService, moduleOptions, submit, handleSubmit, reset };
}
