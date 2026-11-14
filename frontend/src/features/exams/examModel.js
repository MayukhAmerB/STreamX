// Pure helpers for Console -> Exams (no React, unit tested in Node).
// Times are entered and shown in IST: the academy runs on Indian time, and an
// explicit +05:30 offset keeps the server value exact whatever the browser.

export const IST_OFFSET = "+05:30";
const IST_OFFSET_MINUTES = 330;

export const STATE_META = {
  draft: { label: "Draft", tag: "gray" },
  scheduled: { label: "Scheduled", tag: "blue" },
  published: { label: "Published", tag: "green" },
  closed: { label: "Closed", tag: "cool-gray" },
};

export const WINDOW_LABELS = { not_open: "Not open yet", open: "Open now", closed: "Closed" };

export const PARTICIPATION_LABELS = { active: "In progress", submitted: "Submitted", expired: "Time over" };

export function stateMeta(state) {
  return STATE_META[state] || { label: String(state || "Unknown"), tag: "gray" };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

/** "2026-11-20T09:30" (IST wall clock) for an <input type="datetime-local">. */
export function toIstInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
}

/** The ISO value sent to the API for an IST wall-clock input ("" -> null). */
export function fromIstInput(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  return `${text}:00${IST_OFFSET}`;
}

export function formatIstMoment(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  try {
    return `${date.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })} IST`;
  } catch {
    return date.toISOString();
  }
}

export function formatWindow(exam) {
  if (!exam?.opens_at && !exam?.closes_at) return "No window set";
  return `${formatIstMoment(exam.opens_at)} → ${formatIstMoment(exam.closes_at)}`;
}

/** Readiness as "4 of 6 ready" plus the failing items. */
export function readinessSummary(readiness) {
  const items = readiness?.items || [];
  const failing = items.filter((item) => !item.ok);
  return { done: items.length - failing.length, total: items.length, failing, ready: Boolean(readiness?.ready) };
}

/**
 * The primary Console action for an exam: its label, and when disabled the
 * reason shown next to it (Publish stays disabled with the reason while any
 * readiness item fails).
 */
export function publishAction(exam, now = Date.now()) {
  if (!exam) return { label: "Publish", disabled: true, reason: "Loading…" };
  const opensLater = exam.opens_at && Date.parse(exam.opens_at) > now;
  const label = opensLater ? "Schedule" : "Publish now";
  if (!exam.can_manage) return { label, disabled: true, reason: "Only staff can publish exams." };
  if (exam.state === "published") return { label: "Published", disabled: true, reason: "This exam is already published." };
  if (exam.state === "closed") return { label: "Closed", disabled: true, reason: "This exam has closed." };
  if (exam.state === "scheduled") {
    return { label: "Scheduled", disabled: true, reason: `It will publish itself at ${formatIstMoment(exam.opens_at)}.` };
  }
  const { failing } = readinessSummary(exam.readiness);
  if (!exam.readiness || failing.length) {
    const first = failing[0];
    const reason = first ? first.detail || first.label : "Checking readiness…";
    const more = failing.length > 1 ? ` (+${failing.length - 1} more)` : "";
    return { label, disabled: true, reason: `${reason}${more}` };
  }
  return {
    label,
    disabled: false,
    reason: opensLater
      ? `Students are notified, and it opens itself at ${formatIstMoment(exam.opens_at)}.`
      : "Students in the chosen batches are notified now.",
  };
}

export function canClose(exam) {
  return Boolean(exam?.can_manage && exam.state === "published");
}

export function canEditSchedule(exam) {
  return Boolean(exam?.can_manage && exam.state !== "closed");
}

/** Problems listed by the server for an invalid exam file. */
export function uploadProblems(error) {
  const errors = error?.response?.data?.errors;
  if (Array.isArray(errors?.problems)) return errors.problems.map(String);
  return [];
}

/** Human lines for a dry-run report (counts only, never answers). */
export function previewLines(report) {
  if (!report) return [];
  const lines = [
    `${report.exam_created ? "New exam" : "Updates existing exam"} “${report.title || report.slug}” (${report.slug}).`,
    `${report.question_count} question(s), ${report.total_points} points: ${report.created} new, ${report.updated} changed, ${report.unchanged} unchanged, ${report.deactivated} retired, ${report.removed} removed.`,
    `${report.materials_referenced} evidence file(s) referenced.`,
  ];
  if (report.opens_at || report.closes_at) lines.push(`Window: ${formatWindow(report)}.`);
  if (report.time_limit_minutes) lines.push(`Time limit: ${report.time_limit_minutes} minutes.`);
  if (report.changed_with_attempts?.length) {
    lines.push(`Changes questions students already answered: ${report.changed_with_attempts.join(", ")}.`);
  }
  return lines;
}

/** PATCH body for the schedule form (only the fields the form holds). */
export function schedulePayload(form) {
  const limit = String(form?.timeLimit ?? "").trim();
  return {
    opens_at: fromIstInput(form?.opensAt),
    closes_at: fromIstInput(form?.closesAt),
    time_limit_minutes: limit ? Number.parseInt(limit, 10) : null,
    batch_ids: (form?.batchIds || []).map(Number),
  };
}

export function scheduleFormFrom(exam) {
  return {
    opensAt: toIstInput(exam?.opens_at),
    closesAt: toIstInput(exam?.closes_at),
    timeLimit: exam?.time_limit_minutes ? String(exam.time_limit_minutes) : "",
    batchIds: (exam?.batches || []).map((batch) => batch.id),
  };
}

/** Client-side check before saving; returns the first problem or "". */
export function scheduleProblem(form) {
  const opens = fromIstInput(form?.opensAt);
  const closes = fromIstInput(form?.closesAt);
  if (form?.opensAt && !opens) return "Enter a valid opening date and time.";
  if (form?.closesAt && !closes) return "Enter a valid closing date and time.";
  if (opens && closes && Date.parse(closes) <= Date.parse(opens)) return "The exam must close after it opens.";
  const limit = String(form?.timeLimit ?? "").trim();
  if (limit && !(Number.parseInt(limit, 10) >= 1 && Number.parseInt(limit, 10) <= 1440)) {
    return "The time limit must be between 1 and 1440 minutes.";
  }
  return "";
}

export function missingMaterials(exam) {
  return (exam?.questions || []).flatMap((question) =>
    (question.materials || []).filter((item) => !item.uploaded).map((item) => ({ ...item, question: question.key }))
  );
}

/** The Console hub card for a student, from /ctf/eligibility/ (null = no card). */
export function studentExamCard(eligibility, labsUrl) {
  if (!eligibility) return null;
  const exam = eligibility.exam;
  if (eligibility.enabled && exam?.window === "open") {
    return { tone: "open", label: "Exam open now", title: exam.title?.en || exam.slug, meta: `Closes ${formatIstMoment(exam.closes_at)}`, href: labsUrl };
  }
  const next = exam?.window === "not_open" ? exam : eligibility.next_exam;
  if (next?.opens_at) {
    return { tone: "upcoming", label: "Next exam", title: next.title?.en || next.slug, meta: `Opens ${formatIstMoment(next.opens_at)}`, href: labsUrl };
  }
  return null;
}
