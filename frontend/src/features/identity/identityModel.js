// The student identity block, in the owner's order (apps.users.identity):
// 1 roll number, 2 real name, 3 handle (+ most recent), 4 stats, then the
// record's own fields. Pure helpers so every screen renders the same order.
//
// Owner rule (Console): wherever the Console shows students' marks or results
// a student is identified by @handle only, with the roll number as the staff
// reference. The API sends no real name or e-mail on those payloads; these
// helpers never fall back to one either. A student without a handle yet shows
// as "AL-SYD-00042 (no handle)". Real names live in Django admin -> Examination.

export const EMPTY = "—";

export function rollNumber(userId) {
  return `AL-SYD-${String(Number(userId) || 0).padStart(5, "0")}`;
}

function present(value) {
  return value !== null && value !== undefined && value !== "";
}

function percent(value) {
  return present(value) ? `${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%` : EMPTY;
}

export const NO_HANDLE = "(no handle)";

/** "@handle", or "AL-SYD-00042 (no handle)" when the student has none yet. */
export function handleLabel(handle, roll) {
  const clean = String(handle || "").trim().replace(/^@/, "");
  return clean ? `@${clean}` : `${roll || EMPTY} ${NO_HANDLE}`;
}

/**
 * How the Console names a student: the server's `label` when present, else the
 * record's handle, else the most recent one, else the roll number + "(no handle)".
 * Never a real name or an e-mail (owner rule).
 */
export function studentLabel(block, person) {
  if (block?.label) return block.label;
  if (person?.label) return person.label;
  const roll = block?.roll_number || person?.roll_number || (person?.id ? rollNumber(person.id) : EMPTY);
  return handleLabel(block?.handle || block?.handle_most_recent || person?.handle, roll);
}

/**
 * The identity cells, always in this order. The real-name cell appears only on
 * the student's own header (GET /api/me/identity/); Console blocks have none.
 */
export function identityFields(block, { handlesOnly = false } = {}) {
  const roll = block?.roll_number || EMPTY;
  const handle = block?.handle ? `@${block.handle}` : handlesOnly ? handleLabel("", roll) : EMPTY;
  const recent = block?.handle_most_recent ? `@${block.handle_most_recent}` : EMPTY;
  const fields = [{ key: "roll_number", label: "Roll number", value: roll, mono: true }];
  if (!handlesOnly && block && Object.prototype.hasOwnProperty.call(block, "real_name")) {
    fields.push({ key: "real_name", label: "Real name", value: block.real_name || EMPTY });
  }
  fields.push({
    key: "handle",
    label: block?.snapshot ? "Handle at submission" : "Handle",
    value: handle,
    note: block?.handle_changed ? `Most recent: ${recent}` : "",
  });
  return fields;
}

/** The stats strip, always in this order (XP + rank only while engagement is on). */
export function identityStats(stats) {
  const s = stats || {};
  const cells = [];
  if (present(s.xp)) {
    cells.push({ key: "xp", label: "XP", value: Number(s.xp).toLocaleString("en-IN") });
    cells.push({ key: "rank", label: "Rank", value: s.rank || EMPTY });
  }
  cells.push({
    key: "attendance",
    label: "Attendance",
    value: percent(s.attendance_percent),
    note: s.attendance_total ? `${s.attendance_attended} of ${s.attendance_total} classes (40+ min live)` : "40+ min live counts",
  });
  cells.push({
    key: "reports",
    label: "Reports",
    value: String(s.reports_submitted ?? 0),
    note: present(s.reports_graded_average) ? `Graded avg ${percent(s.reports_graded_average)}` : "Graded avg —",
  });
  cells.push({
    key: "exam",
    label: "Exam score",
    value: percent(s.exam_score),
    note: s.exams_taken ? `${s.exams_taken} exam${s.exams_taken === 1 ? "" : "s"}` : "No results yet",
  });
  return cells;
}

/**
 * One line for dense Console lists (queues, rows): "AL-SYD-00042 · @handle", or
 * "AL-SYD-00042 (no handle)". Handles only: never a real name or an e-mail.
 */
export function identityLine(block, fallbackPerson) {
  const label = studentLabel(block, fallbackPerson);
  const roll = block?.roll_number || fallbackPerson?.roll_number || "";
  if (!roll || label.startsWith(roll)) return label;
  return `${roll} · ${label}`;
}

/**
 * The student's own line about themselves (GET /api/gradebook/me/ only):
 * "Real Name · @handle · AL-SYD-00042". The real name is shown only because the
 * API sends it to the requesting student for their own block; Console payloads
 * about other students never carry one, so this never invents it.
 */
export function ownIdentityLine(block) {
  if (!block) return "";
  const roll = block.roll_number || (block.user_id ? rollNumber(block.user_id) : EMPTY);
  const handle = String(block.handle || block.handle_most_recent || "").trim().replace(/^@/, "");
  const name = String(block.real_name || "").trim();
  const parts = handle ? [name, `@${handle}`, roll] : [name, handleLabel("", roll)];
  return parts.filter(Boolean).join(" · ");
}
