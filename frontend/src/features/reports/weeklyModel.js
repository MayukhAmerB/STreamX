// Self-service weekly reports: pure helpers (tested in weeklyModel.test.js).
import { formatIst, formatMarks } from "./reportModel";
import { clientTargetKey } from "./targetKey";

export const TARGET_MIN_LENGTH = 2;
export const UNDO_MS = 10000;

/** Mirrors apps.core.textnorm.target_key for instant client feedback (see targetKey.js). */
export { clientTargetKey };

/** Client-side check of the typed target name: "" when fine. */
export function targetNameError(name = "") {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "Type the name of the target you investigated.";
  if (trimmed.length < TARGET_MIN_LENGTH) return "Use at least 2 characters.";
  if (!clientTargetKey(trimmed)) return "Use letters or numbers in the target name.";
  return "";
}

/** The target already used this week by the student (exact key match), if any. */
export function findExistingTarget(name, targets = []) {
  const key = clientTargetKey(name);
  if (!key) return null;
  return targets.find((target) => clientTargetKey(target.target_name) === key) || null;
}

/**
 * Why the Submit button is disabled ("" = enabled). One inline reason, in the
 * order a student fixes things.
 */
export function submitBlockReason({ enabled = true, disabledReason = "", targetName = "", files = [], busy = false, canChange = true, lockReason = "" } = {}) {
  if (!enabled) return disabledReason || "Reports are not enabled for this course.";
  if (!canChange) return lockReason || "This report can't be changed any more.";
  const nameError = targetNameError(targetName);
  if (nameError) return nameError;
  if (busy) return "Wait for the upload to finish.";
  if (files.some((file) => file.status === "uploading" || file.status === "queued")) return "Wait for the upload to finish.";
  if (files.some((file) => file.scan_status === "infected" || file.blocked_reason)) return "Remove the file the virus scanner blocked.";
  const usable = files.filter((file) => file.status !== "error");
  if (!usable.length) return "Add at least one file.";
  if (usable.some((file) => file.scan_pending || file.scan_status === "unscanned")) return "Checking your files for viruses…";
  return "";
}

/** One line about the week: due time, or the late window with its penalty. */
export function weekStatusText(week, now = Date.now()) {
  if (!week) return "";
  if (week.status === "late") {
    const penalty = Number(week.penalty_percent) || 0;
    return `Late window: accepted until ${formatIst(week.late_until)}${penalty ? ` with ${formatMarks(penalty)}% off` : ""}.`;
  }
  if (week.status === "closed") return "This week is closed.";
  const left = new Date(week.due_at).getTime() - now;
  const soon = left > 0 && left <= 24 * 3600 * 1000;
  return `Due ${formatIst(week.due_at)}${soon ? " (less than a day left)" : ""}.`;
}

/** The week choices offered while last week is in its late window. */
export function weekChoices(weeks = []) {
  return weeks.map((week) => ({
    value: week.which,
    label:
      week.which === "previous"
        ? `Last week (late${Number(week.penalty_percent) ? `, -${formatMarks(week.penalty_percent)}%` : ""})`
        : "This week",
    week,
  }));
}

/** Reads a 409 from POST /reports/me/targets/ into what the form shows. */
export function readTargetConflict(error) {
  const status = error?.response?.status;
  const body = error?.response?.data || {};
  const code = body.code || body.errors?.code || "";
  if (status !== 409) return null;
  return {
    code,
    message: body.message || body.detail || "",
    existing: body.errors?.existing || body.existing || null,
    suggestions: body.errors?.suggestions || body.suggestions || [],
  };
}

export function slotsText(week) {
  if (!week || week.slots_left === null || week.slots_left === undefined) return "";
  if (week.slots_left === 0) return "You have reported on the most targets allowed this week.";
  return `${week.slots_left} more target${week.slots_left === 1 ? "" : "s"} allowed this week.`;
}

/** Normalises server draft files and local uploads into one list for the form. */
export function fileRows(target, localUploads = []) {
  const server = (target?.draft_files || []).map((file) => ({ ...file, key: `server-${file.id}`, status: "done" }));
  const known = new Set(server.map((file) => file.id));
  const local = localUploads.filter((item) => !item.id || !known.has(item.id));
  return [...server, ...local];
}

export function fileStateLabel(file) {
  if (file.status === "uploading" || file.status === "queued") return `Uploading ${Math.round((file.progress || 0) * 100)}%`;
  if (file.status === "error") return file.error || "Upload failed";
  if (file.blocked_reason || file.scan_status === "infected") return `Blocked: ${file.blocked_reason || "virus scanner"}`;
  if (file.scan_pending || file.scan_status === "unscanned") return "Scanning…";
  if (file.scan_status === "clean") return "Ready";
  return "";
}
