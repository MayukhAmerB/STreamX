// Studio "Class details": the topic, module and description the class's
// recording is published with. Calendar classes start with only a calendar
// name ("OSINT Batch IV · Friday 27 Nov"), so without these the lecture was
// "<name> - <date>" in "Class recordings". Works before, during and after the
// class; saving after it renames the lecture already published. OWNER: WS-D1.
import { Button, InlineNotification, Select, SelectItem, TextArea, TextInput } from "@carbon/react";
import { useEffect, useState } from "react";
import { saveRealtimeClassDetails } from "../../api/realtime";
import { apiData, apiMessage } from "../../utils/api";

export const NEW_MODULE = "__new__";

export function initialClassDetails(session) {
  const moduleId = session?.target_module?.id;
  return {
    topic: String(session?.lecture_title || ""),
    description: String(session?.description || ""),
    module: moduleId ? String(moduleId) : "",
    newModule: "",
  };
}

export function classDetailsPayload(form) {
  const payload = { topic: String(form.topic || "").trim(), description: String(form.description || "").trim() };
  if (form.module === NEW_MODULE) {
    const title = String(form.newModule || "").trim();
    if (title) payload.new_module_title = title;
  } else if (form.module) {
    payload.module_id = Number(form.module);
  }
  return payload;
}

export default function ClassDetailsCard({ session, moduleOptions = [], onSaved }) {
  const [form, setForm] = useState(() => initialClassDetails(session));
  const [state, setState] = useState({ saving: false, error: "", info: "" });
  const sessionId = session?.id;

  // A different class opened in the studio: start from its saved details.
  useEffect(() => {
    setForm(initialClassDetails(session));
    setState({ saving: false, error: "", info: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per class, not on every poll
  }, [sessionId]);

  const update = (patch) => setForm((current) => ({ ...current, ...patch }));
  const current = session?.target_module;
  const listed = moduleOptions.some((option) => String(option.id) === form.module);
  const ended = session?.status === "ended";

  const save = async () => {
    if (form.module === NEW_MODULE && !String(form.newModule || "").trim()) {
      setState({ saving: false, error: "Name the new module.", info: "" });
      return;
    }
    setState({ saving: true, error: "", info: "" });
    try {
      const response = await saveRealtimeClassDetails(sessionId, classDetailsPayload(form));
      const data = apiData(response, null);
      if (data?.session) {
        onSaved?.(data.session);
        setForm(initialClassDetails(data.session));
      }
      setState({ saving: false, error: "", info: response?.data?.message || "Class details saved." });
    } catch (err) {
      setState({ saving: false, error: apiMessage(err, "Unable to save the class details."), info: "" });
    }
  };

  return (
    <section className="cls-section" aria-labelledby="cls-details-title" data-testid="class-details">
      <h2 id="cls-details-title" className="cls-section__title">
        Class details
      </h2>
      <p className="cls-help">
        {ended
          ? "Saving renames and moves the recording already published from this class."
          : "The recording is published with these. Fill them in before, during or after the class."}
      </p>
      <TextInput
        id={`cls-details-topic-${sessionId}`}
        labelText="Topic (lecture title)"
        placeholder="e.g. Google dorking: advanced operators"
        maxLength={255}
        value={form.topic}
        onChange={(event) => update({ topic: event.target.value })}
      />
      <Select
        id={`cls-details-module-${sessionId}`}
        labelText="Module"
        value={form.module}
        onChange={(event) => update({ module: event.target.value })}
      >
        <SelectItem value="" text={current?.id ? "Keep the current module" : "Choose automatically (“Class recordings”)"} />
        {form.module && form.module !== NEW_MODULE && !listed ? (
          <SelectItem value={form.module} text={current?.title || "Current module"} />
        ) : null}
        {moduleOptions.map((option) => (
          <SelectItem key={option.id} value={String(option.id)} text={option.title} />
        ))}
        <SelectItem value={NEW_MODULE} text="New module…" />
      </Select>
      {form.module === NEW_MODULE ? (
        <TextInput
          id={`cls-details-new-module-${sessionId}`}
          labelText="New module name"
          placeholder="e.g. OSINT ADVANCED - SOCIAL MEDIA INTELLIGENCE"
          maxLength={255}
          value={form.newModule}
          onChange={(event) => update({ newModule: event.target.value })}
        />
      ) : null}
      <TextArea
        id={`cls-details-description-${sessionId}`}
        labelText="Description"
        placeholder="What this class covered"
        rows={3}
        maxLength={5000}
        value={form.description}
        onChange={(event) => update({ description: event.target.value })}
      />
      {state.error ? (
        <InlineNotification lowContrast kind="error" title="Class details" subtitle={state.error} hideCloseButton />
      ) : null}
      {state.info ? (
        <p className="cls-help" role="status">
          {state.info}
        </p>
      ) : null}
      <div className="cls-card__actions">
        <Button kind="primary" size="md" disabled={state.saving || !sessionId} onClick={save}>
          {state.saving ? "Saving…" : "Save details"}
        </Button>
      </div>
    </section>
  );
}
