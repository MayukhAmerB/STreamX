// Pure helpers for weekly reports: status chips, IST dates, countdowns, file
// rules, marks maths. No React or Carbon imports, so everything here is unit
// tested in plain Node.

export const IST_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

// --- File types ---------------------------------------------------------------
export const REPORT_EXTENSIONS = [
  "pdf",
  "pptx",
  "ppt",
  "docx",
  "doc",
  "odt",
  "odp",
  "md",
  "canvas",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "svg",
  "zip",
];

export const FILE_TYPE_GROUPS = [
  { id: "pdf", label: "PDF", extensions: ["pdf"] },
  { id: "slides", label: "Slides (PPTX, PPT, ODP)", extensions: ["pptx", "ppt", "odp"] },
  { id: "documents", label: "Documents (DOCX, DOC, ODT)", extensions: ["docx", "doc", "odt"] },
  { id: "obsidian", label: "Obsidian notes, canvases and vault .zip", extensions: ["md", "canvas", "zip"] },
  { id: "images", label: "Exported graphs (PNG, JPG, WEBP, SVG)", extensions: ["png", "jpg", "jpeg", "webp", "svg"] },
];

const MACRO_EXTENSIONS = new Set(["pptm", "potm", "ppsm", "ppam", "sldm", "docm", "dotm", "xlsm", "xltm", "xlam"]);

export function fileExtension(name = "") {
  const match = /\.([^./\\]+)$/.exec(String(name || "").trim());
  return match ? match[1].toLowerCase() : "";
}

/** "PDF, PPTX, DOCX, MD, CANVAS…" for hints, collapsing jpg/jpeg. */
export function describeExtensions(extensions = REPORT_EXTENSIONS) {
  const unique = [];
  extensions.forEach((ext) => {
    const label = ext === "jpeg" ? "JPG" : ext.toUpperCase();
    if (!unique.includes(label)) unique.push(label);
  });
  return unique.join(", ");
}

/** `accept` attribute for <input type="file">. */
export function acceptAttribute(extensions = REPORT_EXTENSIONS) {
  return extensions.map((ext) => `.${ext}`).join(",");
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= MB) return `${(value / MB).toFixed(value >= 10 * MB ? 0 : 1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/**
 * Checks picked files before any upload starts. `existing` are files already
 * in the list (uploaded, uploading or kept from the last version).
 * Returns { accepted: File[], rejected: [{ file, name, reason }] }.
 */
export function validatePickedFiles(files, rules = {}, existing = []) {
  const allowed = new Set((rules.allowedExtensions?.length ? rules.allowedExtensions : REPORT_EXTENSIONS).map(String));
  const maxFiles = Number(rules.maxFiles) || 5;
  const maxFileBytes = (Number(rules.maxFileSizeMb) || 50) * MB;
  const maxTotalBytes = (Number(rules.maxTotalSizeMb) || 200) * MB;
  let count = existing.length;
  let total = existing.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const seen = new Set(existing.map((item) => `${item.name}|${item.size}`));
  const accepted = [];
  const rejected = [];
  Array.from(files || []).forEach((file) => {
    const name = String(file?.name || "");
    const size = Number(file?.size) || 0;
    const ext = fileExtension(name);
    const reject = (reason) => rejected.push({ file, name: name || "File", reason });
    if (MACRO_EXTENSIONS.has(ext)) {
      reject("Macro-enabled files aren't accepted. Save it as .pptx or .docx.");
    } else if (!allowed.has(ext)) {
      reject(ext ? `.${ext} files aren't accepted for this report.` : "Files need an extension, such as .pdf.");
    } else if (size <= 0) {
      reject("This file is empty.");
    } else if (size > maxFileBytes) {
      reject(`Larger than the ${formatBytes(maxFileBytes)} limit per file.`);
    } else if (seen.has(`${name}|${size}`)) {
      reject("This file is already in the list.");
    } else if (count + 1 > maxFiles) {
      reject(`You can attach up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}.`);
    } else if (total + size > maxTotalBytes) {
      reject(`All files together must stay under ${formatBytes(maxTotalBytes)}.`);
    } else {
      accepted.push(file);
      seen.add(`${name}|${size}`);
      count += 1;
      total += size;
    }
  });
  return { accepted, rejected };
}

// --- Dates ----------------------------------------------------------------------
const istFormatters = new Map();
function istFormatter(key, options) {
  if (!istFormatters.has(key)) {
    istFormatters.set(key, new Intl.DateTimeFormat("en-IN", { timeZone: IST_TIME_ZONE, ...options }));
  }
  return istFormatters.get(key);
}

/** "Fri 14 Nov, 11:59 pm IST" */
export function formatIst(value, { withWeekday = true, withYear = false } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const options = {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(withWeekday ? { weekday: "short" } : {}),
    ...(withYear ? { year: "numeric" } : {}),
  };
  const parts = istFormatter(`${withWeekday}|${withYear}`, options).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const dayPart = [withWeekday ? get("weekday") : "", get("day"), get("month"), withYear ? get("year") : ""]
    .filter(Boolean)
    .join(" ");
  return `${dayPart}, ${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()} IST`;
}

function plural(value, word) {
  return `${value} ${word}${value === 1 ? "" : "s"}`;
}

/** Human duration: "2 days 4 h", "3 h 20 min", "12 min", "less than a minute". */
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < MINUTE) return "less than a minute";
  const days = Math.floor(value / DAY);
  const hours = Math.floor((value % DAY) / HOUR);
  const minutes = Math.floor((value % HOUR) / MINUTE);
  if (days > 0) return hours ? `${plural(days, "day")} ${hours} h` : plural(days, "day");
  if (hours > 0) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  return `${minutes} min`;
}

/** Countdown for a deadline: { text, tone } where tone is "calm" | "soon" | "urgent" | "past". */
export function getCountdown(dueAt, now = Date.now()) {
  const due = new Date(dueAt).getTime();
  if (!Number.isFinite(due)) return { text: "", tone: "calm" };
  const remaining = due - now;
  if (remaining <= 0) return { text: `Deadline passed ${formatDuration(-remaining)} ago`, tone: "past" };
  const tone = remaining <= 6 * HOUR ? "urgent" : remaining <= 2 * DAY ? "soon" : "calm";
  return { text: `Due in ${formatDuration(remaining)}`, tone };
}

export function formatMinutesLate(minutes) {
  const value = Number(minutes) || 0;
  if (value <= 0) return "";
  return `${formatDuration(value * MINUTE)} late`;
}

/** ISO -> "YYYY-MM-DDTHH:mm" in IST for <input type="datetime-local">. */
export function toIstInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * MINUTE);
  return shifted.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" typed in IST -> ISO string with the +05:30 offset. */
export function fromIstInputValue(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  return `${text}:00+05:30`;
}

export function addDaysIso(value, days) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + days * DAY).toISOString();
}

// --- Marks ------------------------------------------------------------------------
/** "8.50" -> "8.5", "10.00" -> "10"; empty for null. */
export function formatMarks(value) {
  if (value === null || value === undefined || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * 100) / 100);
}

/** Exact 2-decimal arithmetic: marks as integer hundredths. */
export function toHundredths(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

export function fromHundredths(value) {
  if (value === null || value === undefined) return null;
  return formatMarks(value / 100);
}

/**
 * Validates a marks field. Returns "" when valid, else a sentence.
 * `max` may be a string such as "10.00".
 */
export function validateMarksInput(value, max, { required = true } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return required ? "Enter the marks." : "";
  if (!/^\d+(\.\d+)?$/.test(text)) return "Enter a number, such as 8.5.";
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return "Use at most two decimal places.";
  const hundredths = toHundredths(text);
  const maxHundredths = toHundredths(formatMarks(max)) ?? 0;
  if (hundredths > maxHundredths) return `Marks can't be more than ${formatMarks(max)}.`;
  return "";
}

/** Late penalty preview, matching the server: % of max marks per started day, capped at the marks. */
export function latePenalty({ rawMarks, maxMarks, minutesLate, percentPerDay }) {
  const raw = toHundredths(formatMarks(rawMarks));
  if (raw === null) return { penalty: null, final: null, days: 0 };
  const minutes = Number(minutesLate) || 0;
  const percent = Number(percentPerDay) || 0;
  const days = minutes > 0 ? Math.ceil(minutes / (24 * 60)) : 0;
  if (!days || !percent) return { penalty: "0", final: fromHundredths(raw), days };
  const maxHundredths = toHundredths(formatMarks(maxMarks)) ?? 0;
  const penalty = Math.min(raw, Math.round((maxHundredths * percent * days) / 100));
  return { penalty: fromHundredths(penalty), final: fromHundredths(Math.max(0, raw - penalty)), days };
}

/** Sum of rubric marks (strings); null when nothing valid was entered. */
export function rubricTotal(criteria = [], values = {}) {
  let total = 0;
  let any = false;
  criteria.forEach((criterion) => {
    const hundredths = toHundredths(values[String(criterion.id)]);
    if (hundredths !== null) {
      total += hundredths;
      any = true;
    }
  });
  return any ? fromHundredths(total) : null;
}

/** Sum of the criteria's maximum marks, as a marks string. */
export function rubricMaximum(criteria = []) {
  const total = criteria.reduce((sum, item) => sum + (toHundredths(formatMarks(item.max_marks)) || 0), 0);
  return fromHundredths(total);
}

/**
 * Totals across graded tasks (cells from the API): sum, out of, percentage,
 * missing and late counts. Integer hundredths, so 0.1 + 0.2 stays exact.
 */
export function summarizeMarks(cells = []) {
  let total = 0;
  let outOf = 0;
  let graded = 0;
  cells.forEach((cell) => {
    const marks = toHundredths(formatMarks(cell.final_marks));
    if (marks === null) return;
    total += marks;
    outOf += toHundredths(formatMarks(cell.max_marks)) || 0;
    graded += 1;
  });
  return {
    total: fromHundredths(total),
    outOf: fromHundredths(outOf),
    percentage: outOf ? Math.round((total * 10000) / outOf) / 100 : null,
    graded,
    missing: cells.filter((cell) => cell.is_missing).length,
    late: cells.filter((cell) => cell.is_late).length,
  };
}

/** Points for the marks-per-week trend: graded tasks in due order. */
export function getTrendPoints(tasks = [], cells = []) {
  const byTask = new Map(cells.map((cell) => [cell.task_id, cell]));
  return [...tasks]
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at))
    .map((task, index) => {
      const cell = byTask.get(task.id);
      const marks = Number(cell?.final_marks);
      const max = Number(task.max_marks);
      if (!cell || cell.final_marks === null || cell.final_marks === undefined || !max) return null;
      return {
        id: task.id,
        label: task.week_number ? `W${task.week_number}` : `#${index + 1}`,
        title: task.title,
        marks: formatMarks(marks),
        max: formatMarks(max),
        percent: Math.round((marks / max) * 1000) / 10,
      };
    })
    .filter(Boolean);
}

// --- Status chips ------------------------------------------------------------------
export const STATUS_LABELS = {
  not_submitted: "Not submitted",
  submitted: "Submitted",
  under_review: "Under review",
  graded: "Graded",
  returned_for_revision: "Returned",
  resubmitted: "Resubmitted",
  missing: "Missing",
};

/**
 * The chip for a student's report: { id, label, tone, icon }.
 * Tones: "neutral" | "accent" | "info" | "success" | "warning" | "error".
 * Icons are keys resolved by StatusChip.jsx (status is never colour alone).
 */
export function getStatusChip(item = {}) {
  const status = item.status || "not_submitted";
  if (status === "graded") {
    if (item.marks_visible && item.final_marks !== null && item.final_marks !== undefined) {
      return {
        id: "graded",
        label: `Graded ${formatMarks(item.final_marks)}/${formatMarks(item.max_marks)}`,
        tone: "success",
        icon: "graded",
      };
    }
    return { id: "graded", label: "Graded · marks soon", tone: "success", icon: "graded" };
  }
  if (status === "returned_for_revision") return { id: "returned", label: "Returned", tone: "warning", icon: "returned" };
  if (status === "under_review") return { id: "under_review", label: "Under review", tone: "info", icon: "review" };
  if (status === "resubmitted") return { id: "resubmitted", label: "Resubmitted", tone: "accent", icon: "submitted" };
  if (status === "submitted") {
    return item.is_late
      ? { id: "late", label: "Late", tone: "warning", icon: "late" }
      : { id: "submitted", label: "Submitted", tone: "accent", icon: "submitted" };
  }
  if (status === "missing" || (item.window === "closed" && status === "not_submitted")) {
    return { id: "missing", label: "Not submitted", tone: "error", icon: "missing" };
  }
  return { id: "not_submitted", label: "Not submitted", tone: "neutral", icon: "pending" };
}

/**
 * Splits the student's list: `current` is this week's target (the open task
 * due soonest that still needs work, else the open one due soonest), `open`
 * the other open tasks, `past` everything else (newest first).
 */
export function splitTasks(tasks = []) {
  const open = tasks
    .filter((task) => task.window === "open" || task.window === "late")
    .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  const needsWork = open.find((task) => ["not_submitted", "returned_for_revision"].includes(task.status));
  const current = needsWork || open[0] || null;
  const openRest = open.filter((task) => task !== current);
  const past = tasks
    .filter((task) => task !== current && !openRest.includes(task))
    .sort((a, b) => new Date(b.due_at) - new Date(a.due_at));
  return { current, open: openRest, past };
}

/** Late-policy sentence for the task page. */
export function describeLatePolicy(task = {}) {
  if (task.late_policy !== "allow_late" || !task.late_until) return "Late submissions are not accepted.";
  const penalty = Number(task.late_penalty_percent_per_day) || 0;
  const until = formatIst(task.late_until);
  return penalty
    ? `Late reports are accepted until ${until}, with ${formatMarks(penalty)}% of the marks taken off per day late.`
    : `Late reports are accepted until ${until} without a penalty.`;
}

/** Receipt id students can quote: R-<submission>-v<version>. */
export function receiptId(submission) {
  if (!submission?.id) return "";
  return `R-${submission.id}-v${submission.current_version?.number ?? submission.version_count ?? 1}`;
}
