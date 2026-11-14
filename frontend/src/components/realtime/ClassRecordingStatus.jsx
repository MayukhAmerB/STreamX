import Button from "../Button";

/** @typedef {import("../../api/realtimeLive").ClassRecording} ClassRecording */
/** @typedef {{ id: number, title: string }} ModuleChoice */

// Recording is automatic for every class: there is no Start/Stop Recording
// button. This card only shows what the server is doing, lets the host or an
// admin override the module (optional), and gives admins "Re-run finalize".

const SOURCE_LABELS = {
  server: "Server recording",
  obs_upload: "OBS upload",
  livekit_egress: "Meeting recording",
  imported: "Imported recording",
  browser_fallback: "Browser recording",
};

export const ACTIVE_RECORDING_STATES = new Set(["recording", "finalizing", "processing"]);
export const AUTO_MODULE_TITLE = "Class recordings";

/**
 * @param {ClassRecording} recording
 * @returns {{ tone: "live" | "busy" | "done" | "failed", label: string }}
 */
export function describeClassRecording(recording) {
  const moduleTitle = String(recording?.module?.title || "").trim();
  switch (recording?.state) {
    case "recording":
      return { tone: "live", label: "Recording the class..." };
    case "finalizing":
      return { tone: "busy", label: "Saving recording..." };
    case "processing":
      if (recording?.lecture?.is_published) {
        return {
          tone: "done",
          label: moduleTitle ? `Published to ${moduleTitle} (HD processing)` : "Published (HD processing)",
        };
      }
      return { tone: "busy", label: "Saving recording..." };
    case "published":
      return {
        tone: "done",
        label: moduleTitle ? `Published to ${moduleTitle}` : "Published",
      };
    case "failed": {
      const reason = String(recording?.error || "").trim();
      return { tone: "failed", label: reason ? `Recording failed: ${reason}` : "Recording failed" };
    }
    case "imported":
      return { tone: "busy", label: "Found on the server, waiting for a module" };
    default:
      return { tone: "busy", label: String(recording?.state || "Pending") };
  }
}

/** @param {ClassRecording[]} recordings */
export function hasActiveClassRecording(recordings) {
  return (
    Array.isArray(recordings) &&
    recordings.some((row) => ACTIVE_RECORDING_STATES.has(row?.state) && !(row?.state === "processing" && row?.lecture?.is_published))
  );
}

/** @param {ClassRecording} recording */
export function canRerunFinalize(recording) {
  return Boolean(recording) && recording.state !== "published" && recording.state !== "finalizing";
}

const TONE_CLASSES = {
  live: "text-[#F3E2B3]",
  busy: "text-[#d4d4d4]",
  done: "text-[#fafafa]",
  failed: "text-[#fafafa] underline decoration-dotted underline-offset-4",
};

function ModulePicker({ recording, moduleOptions, onChangeModule, changing }) {
  const selectId = `class-recording-module-${recording.id}`;
  const disabled = changing || recording.can_choose_module === false;
  const currentId = recording?.module?.id ?? "";
  const known = moduleOptions.some((option) => option.id === currentId);
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={selectId} className="text-[11px] text-[#9A9A9A]">
        Module
      </label>
      <select
        id={selectId}
        className="min-h-9 rounded-md border border-white/15 bg-[#0A0A0A] px-2 py-1 text-xs text-white disabled:opacity-60"
        value={currentId === "" ? "" : String(currentId)}
        disabled={disabled}
        title={recording.can_choose_module === false ? "The recording is being saved; try again in a moment." : undefined}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (next && next !== currentId) onChangeModule(recording, next);
        }}
      >
        {currentId === "" ? <option value="">Choose automatically</option> : null}
        {currentId !== "" && !known ? <option value={String(currentId)}>{recording.module?.title}</option> : null}
        {moduleOptions.map((option) => (
          <option key={option.id} value={String(option.id)}>
            {option.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * @param {{
 *   recordings?: ClassRecording[],
 *   targetModule?: { title?: string } | null,
 *   loading?: boolean,
 *   error?: string,
 *   retryingId?: number | null,
 *   onRetry?: (recording: ClassRecording) => void,
 *   moduleOptions?: ModuleChoice[],
 *   onChangeModule?: (recording: ClassRecording, moduleId: number) => void,
 *   changingModuleId?: number | null,
 *   isAdmin?: boolean,
 *   onRerunFinalize?: (recording: ClassRecording) => void,
 *   rerunningId?: number | null,
 *   limit?: number,
 * }} props
 */
export default function ClassRecordingStatus({
  recordings = [],
  targetModule = null,
  loading = false,
  error = "",
  retryingId = null,
  onRetry,
  moduleOptions = [],
  onChangeModule,
  changingModuleId = null,
  isAdmin = false,
  onRerunFinalize,
  rerunningId = null,
  limit = 3,
}) {
  const rows = (Array.isArray(recordings) ? recordings : []).slice(0, limit);
  const moduleTitle = String(targetModule?.title || "").trim();
  const options = Array.isArray(moduleOptions) ? moduleOptions : [];
  return (
    <div className="rounded-xl border border-black panel-gradient px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-[#949494]">Class Recording</div>
      <p className="mt-1 text-xs text-[#BEBEBE]">
        {moduleTitle
          ? `This class is recorded automatically and published to ${moduleTitle} when it ends.`
          : `This class is recorded automatically. With no module chosen it is published to "${AUTO_MODULE_TITLE}" and an admin is asked to review it.`}
      </p>
      {rows.length ? (
        <ul className="mt-2 space-y-2">
          {rows.map((recording) => {
            const { tone, label } = describeClassRecording(recording);
            const lectureTitle = String(recording?.lecture?.title || "").trim();
            return (
              <li key={recording.id} className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-xs font-semibold ${TONE_CLASSES[tone]}`} role={tone === "failed" ? "alert" : undefined}>
                    {label}
                  </p>
                  <p className="text-[11px] text-[#9A9A9A]">
                    {SOURCE_LABELS[recording.source] || recording.source}
                    {lectureTitle ? ` · Lecture: ${lectureTitle}` : ""}
                  </p>
                  {recording.needs_review ? (
                    <p className="mt-0.5 text-[11px] text-[#F3E2B3]" title={recording.review_reason || undefined}>
                      Needs review{recording.review_reason ? `: ${recording.review_reason}` : ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {onChangeModule && options.length ? (
                    <ModulePicker
                      recording={recording}
                      moduleOptions={options}
                      onChangeModule={onChangeModule}
                      changing={changingModuleId === recording.id}
                    />
                  ) : null}
                  {recording.state === "failed" && recording.can_retry && onRetry ? (
                    <Button
                      type="button"
                      variant="secondary"
                      className="px-3 py-1.5 text-xs"
                      loading={retryingId === recording.id}
                      onClick={() => onRetry(recording)}
                    >
                      Retry
                    </Button>
                  ) : null}
                  {isAdmin && onRerunFinalize && canRerunFinalize(recording) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-3 py-1.5 text-xs"
                      loading={rerunningId === recording.id}
                      onClick={() => onRerunFinalize(recording)}
                    >
                      Re-run finalize
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-[#9A9A9A]">
          {loading ? "Checking recordings..." : "No recording yet. It starts by itself when the class goes live."}
        </p>
      )}
      {error ? <p className="mt-2 text-xs text-[#fafafa]">{error}</p> : null}
    </div>
  );
}
