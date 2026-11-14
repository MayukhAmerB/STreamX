// Pure helpers for Console -> Upload class recording.

export const RESUME_STORAGE_KEY = "alsyed.recordingUpload.v1";
export const RECORDING_ACCEPT = ".mp4,.mkv,.mov,.m4v,.flv,.ts,.webm,video/mp4,video/x-matroska,video/quicktime";
const EXTENSIONS = ["mp4", "mkv", "mov", "m4v", "flv", "ts", "webm"];

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond) {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "–";
}

export function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${total % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function isRecordingFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return EXTENSIONS.includes(ext);
}

export const PHASE_LABELS = {
  idle: "Ready",
  uploading: "Uploading",
  retrying: "Connection lost – retrying",
  paused: "Paused",
  completing: "Finishing upload",
  processing: "Processing on the server",
  done: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || phase;
}

/** "Replaces the auto-recording in <module>" / "Creates the lecture in <module>". */
export function targetOutcome(target) {
  if (!target) return "";
  if (target.action === "replaced") {
    return `Replaces the video of “${target.lecture_title}” in ${target.module_title}. Students keep their progress and comments.`;
  }
  return `Creates and publishes the lecture in ${target.module_title || "the course"}.`;
}

export function targetLabel(target, format = (value) => value) {
  const when = target?.started_at ? format(target.started_at) : "";
  const state = target?.status === "live" ? "live now" : when;
  return [target?.title, target?.course_title, state].filter(Boolean).join(" · ");
}

/** The upload the server reports as finished, as the success card shows it. */
export function resultSummary(upload) {
  const result = upload?.result;
  if (!result) return "";
  return result.action === "replaced"
    ? `The better copy replaced the auto-recording in “${result.lecture_title}”.`
    : `“${result.lecture_title}” was created and published.`;
}

// ---- resume after a page refresh (per browser) ---------------------------

export function readResumeRecord(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(RESUME_STORAGE_KEY);
    const record = raw ? JSON.parse(raw) : null;
    return record && record.id ? record : null;
  } catch {
    return null;
  }
}

export function writeResumeRecord(record, storage = safeStorage()) {
  try {
    if (record) storage?.setItem(RESUME_STORAGE_KEY, JSON.stringify(record));
    else storage?.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // Private mode / storage full: resuming still works through the server.
  }
}

export function resumeRecordFor(upload, file, sessionId) {
  return {
    id: upload.id,
    sessionId,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified || 0,
  };
}

export function fileMatchesRecord(file, record) {
  return Boolean(file && record && file.name === record.name && file.size === record.size);
}

function safeStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
