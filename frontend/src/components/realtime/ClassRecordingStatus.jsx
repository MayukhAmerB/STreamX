import Button from "../Button";

/** @typedef {import("../../api/realtimeLive").ClassRecording} ClassRecording */

const SOURCE_LABELS = {
  server: "Server recording",
  obs_upload: "OBS upload",
  livekit_egress: "Host Studio recording",
};

export const ACTIVE_RECORDING_STATES = new Set(["recording", "finalizing", "processing"]);

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
    case "processing":
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
    default:
      return { tone: "busy", label: String(recording?.state || "Pending") };
  }
}

/** @param {ClassRecording[]} recordings */
export function hasActiveClassRecording(recordings) {
  return Array.isArray(recordings) && recordings.some((row) => ACTIVE_RECORDING_STATES.has(row?.state));
}

const TONE_CLASSES = {
  live: "text-red-200",
  busy: "text-amber-200",
  done: "text-emerald-200",
  failed: "text-red-300",
};

export default function ClassRecordingStatus({
  recordings = [],
  targetModule = null,
  loading = false,
  error = "",
  retryingId = null,
  onRetry,
  limit = 3,
}) {
  const rows = (Array.isArray(recordings) ? recordings : []).slice(0, limit);
  const moduleTitle = String(targetModule?.title || "").trim();
  return (
    <div className="rounded-xl border border-black panel-gradient px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-[#949494]">Class Recording</div>
      <p className="mt-1 text-xs text-[#BEBEBE]">
        {moduleTitle
          ? `Recordings of this class are published to ${moduleTitle}.`
          : "No module is selected for this class, so its recording will not be published to a module."}
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
                </div>
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
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-[#9A9A9A]">{loading ? "Checking recordings..." : "No recording yet."}</p>
      )}
      {error ? <p className="mt-2 text-xs text-red-300">{error}</p> : null}
    </div>
  );
}
