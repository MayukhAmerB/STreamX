// The student identity block, in the owner's order (apps.users.identity):
// 1 roll number, 2 real name, 3 handle (+ most recent), 4 stats, then the
// record's own fields. Pure helpers so every screen renders the same order.

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

/** The three identity cells, always in this order. */
export function identityFields(block) {
  const handle = block?.handle ? `@${block.handle}` : EMPTY;
  const recent = block?.handle_most_recent ? `@${block.handle_most_recent}` : EMPTY;
  return [
    { key: "roll_number", label: "Roll number", value: block?.roll_number || EMPTY, mono: true },
    { key: "real_name", label: "Real name", value: block?.real_name || EMPTY },
    {
      key: "handle",
      label: block?.snapshot ? "Handle at submission" : "Handle",
      value: handle,
      note: block?.handle_changed ? `Most recent: ${recent}` : "",
    },
  ];
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

/** One line for dense lists (queues, rows): "AL-SYD-00042 · Asha Rao · @handle". */
export function identityLine(block, fallbackPerson) {
  if (!block) return fallbackPerson?.full_name || fallbackPerson?.email || EMPTY;
  const name = block.real_name || fallbackPerson?.full_name || fallbackPerson?.email || EMPTY;
  return [block.roll_number || EMPTY, name, block.handle ? `@${block.handle}` : EMPTY].join(" · ");
}
