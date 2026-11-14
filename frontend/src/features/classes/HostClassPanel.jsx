// "Host a class": one flow with a mode choice (Broadcast · Interactive
// meeting), in a side panel over the Classes list (full screen on phones).
// OWNER: WS-D1.
import { Button, InlineNotification, Select, SelectItem, TextArea, TextInput } from "@carbon/react";
import { Screen, UserMultiple, Video } from "@carbon/icons-react";
import { SidePanel } from "../app-shell/ui";
import {
  MODE_BROADCAST,
  MODE_MEETING,
  STREAM_SERVICE_ALSYED,
  STREAM_SERVICE_OBS,
  liveClassOptionLabel,
  moduleOptionLabel,
} from "./classesModel";

const FORM_ID = "cls-host-form";

const MODES = [
  {
    key: MODE_BROADCAST,
    label: "Broadcast",
    hint: "One-to-many stream with chat. Up to 500 viewers.",
    icon: Video,
  },
  {
    key: MODE_MEETING,
    label: "Interactive meeting",
    hint: "Everyone can talk on camera. Up to 200 people.",
    icon: UserMultiple,
  },
];

const SOURCES = [
  { key: STREAM_SERVICE_ALSYED, label: "This browser", hint: "Camera or screen share, no software needed.", icon: Screen },
  { key: STREAM_SERVICE_OBS, label: "OBS", hint: "Stream from OBS with a server URL and key.", icon: Video },
];

function ChoiceGroup({ legend, name, value, options, onChange }) {
  return (
    <fieldset className="cls-choice">
      <legend className="cls-label">{legend}</legend>
      <div className="cls-choice__options">
        {options.map((option) => {
          const Icon = option.icon;
          const id = `${name}-${option.key}`;
          return (
            <label key={option.key} htmlFor={id} className="cls-choice__option">
              <input
                id={id}
                type="radio"
                name={name}
                value={option.key}
                checked={value === option.key}
                onChange={() => onChange(option.key)}
              />
              <Icon size={20} aria-hidden="true" className="cls-choice__icon" />
              <span className="cls-choice__text">
                <span className="cls-choice__title">{option.label}</span>
                <span className="cls-choice__hint">{option.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function moduleSelectPlaceholder(form, moduleOptions) {
  if (!form.linked_live_class_id) return "Choose a live class first";
  if (moduleOptions.loading) return "Loading modules…";
  return moduleOptions.modules.length ? "Choose automatically" : "“Class recordings” (created for you)";
}

function BroadcastFields({ form, update, setStreamService, moduleOptions }) {
  const browser = form.stream_service === STREAM_SERVICE_ALSYED;
  return (
    <>
      <ChoiceGroup legend="Stream from" name="cls-source" value={form.stream_service} options={SOURCES} onChange={setStreamService} />
      <Select
        id="cls-target-module"
        labelText="Save the recording to"
        helperText={
          moduleOptions.course
            ? `Optional. A lecture in this module of ${moduleOptions.course.title}; left empty, it goes to the live class's default module or “Class recordings”.`
            : "Every class is recorded and published to the course when it ends."
        }
        invalid={Boolean(moduleOptions.error)}
        invalidText={moduleOptions.error}
        value={form.target_module_id}
        disabled={!form.linked_live_class_id || moduleOptions.loading}
        onChange={(event) => update({ target_module_id: event.target.value })}
      >
        <SelectItem value="" text={moduleSelectPlaceholder(form, moduleOptions)} />
        {moduleOptions.modules.map((module) => (
          <SelectItem key={module.id} value={String(module.id)} text={moduleOptionLabel(module)} />
        ))}
      </Select>
      {browser ? (
        <details className="cls-disclosure">
          <summary>Custom player and chat links (optional)</summary>
          <div className="cls-disclosure__body">
            <TextInput
              id="cls-stream-embed"
              labelText="Stream embed URL"
              value={form.stream_embed_url}
              onChange={(event) => update({ stream_embed_url: event.target.value })}
            />
            <TextInput
              id="cls-chat-embed"
              labelText="Chat embed URL"
              value={form.chat_embed_url}
              onChange={(event) => update({ chat_embed_url: event.target.value })}
            />
            <TextInput
              id="cls-rtmp-target"
              labelText="RTMP target URL"
              value={form.rtmp_target_url}
              onChange={(event) => update({ rtmp_target_url: event.target.value })}
            />
          </div>
        </details>
      ) : (
        <TextInput
          id="cls-obs-server"
          labelText="OBS server URL"
          placeholder="rtmp://your-host:1935/live"
          helperText="The stream key is managed by the server. You copy it from the studio after you create the class."
          value={form.obs_stream_server_url}
          onChange={(event) => update({ obs_stream_server_url: event.target.value })}
        />
      )}
    </>
  );
}

export default function HostClassPanel({ open, onClose, liveClasses, formState }) {
  const { form, update, setStreamService, moduleOptions, submit, handleSubmit } = formState;
  const meeting = form.mode === MODE_MEETING;
  return (
    <SidePanel
      open={open}
      title="Host a class"
      onClose={onClose}
      footer={
        <>
          <Button kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" form={FORM_ID} className="sc-button--accent cls-accent" disabled={submit.loading}>
            {submit.loading ? "Creating…" : "Create class"}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="cls-form" onSubmit={handleSubmit} noValidate>
        <ChoiceGroup
          legend="How will you teach?"
          name="cls-mode"
          value={form.mode}
          options={MODES}
          onChange={(mode) => update({ mode, target_module_id: "" })}
        />
        <Select
          id="cls-live-class"
          labelText="Live class"
          helperText={liveClasses.loading ? "Loading live classes…" : liveClasses.items.length ? "" : "No live classes yet. Create one in the back office first."}
          value={form.linked_live_class_id}
          onChange={(event) => update({ linked_live_class_id: event.target.value, target_module_id: "" })}
          required
        >
          <SelectItem value="" text="Choose a live class" />
          {liveClasses.items.map((item) => (
            <SelectItem key={item.id} value={String(item.id)} text={liveClassOptionLabel(item)} />
          ))}
        </Select>
        <TextInput
          id="cls-title"
          labelText="Class title"
          placeholder={meeting ? "Mentoring: week 3" : "OSINT live: Friday batch"}
          value={form.title}
          onChange={(event) => update({ title: event.target.value })}
          invalid={submit.error === "Give the class a title."}
          invalidText="Give the class a title."
          required
        />
        <TextArea
          id="cls-description"
          labelText="Description (optional)"
          rows={3}
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
        />
        {meeting ? (
          <TextInput
            id="cls-capacity"
            labelText="Seats on camera"
            helperText="2 to 200. People beyond this number watch as a broadcast."
            type="number"
            inputMode="numeric"
            min={2}
            max={200}
            value={form.meeting_capacity}
            onChange={(event) => update({ meeting_capacity: event.target.value })}
          />
        ) : (
          <BroadcastFields form={form} update={update} setStreamService={setStreamService} moduleOptions={moduleOptions} />
        )}
        {submit.error ? (
          <InlineNotification lowContrast kind="error" title="Not created" subtitle={submit.error} hideCloseButton role="alert" />
        ) : null}
      </form>
    </SidePanel>
  );
}
