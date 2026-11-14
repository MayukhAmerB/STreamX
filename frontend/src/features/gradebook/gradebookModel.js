// Pure helpers for the unified gradebook (weekly reports + CTF exams).

export const CELL_STATUS_LABELS = {
  missing: "Missing",
  not_submitted: "Not submitted",
  submitted: "Submitted",
  under_review: "Under review",
  resubmitted: "Resubmitted",
  returned_for_revision: "Returned",
  graded: "Graded",
  absent: "Absent",
  pending: "Pending",
  in_progress: "In progress",
  result: "Result",
};

export function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "–";
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatPercent(value) {
  return value === null || value === undefined ? "–" : `${formatNumber(value)}%`;
}

/** What a cell shows: "8/10", "40/40 (#1)", or a status word. */
export function cellText(cell) {
  if (!cell) return "–";
  if (cell.value !== null && cell.value !== undefined) {
    const max = cell.max !== null && cell.max !== undefined ? `/${formatNumber(cell.max)}` : "";
    const rank = cell.kind === "exam" && cell.rank ? ` (#${cell.rank})` : "";
    return `${formatNumber(cell.value)}${max}${rank}`;
  }
  return CELL_STATUS_LABELS[cell.status] || String(cell.status || "–").replace(/_/g, " ");
}

export function cellTone(cell) {
  if (!cell) return "";
  if (cell.status === "missing" || cell.status === "absent") return "missing";
  if (cell.value === null || cell.value === undefined) return "pending";
  return "";
}

export function columnLabel(column) {
  const kind = column?.kind === "exam" ? "Exam" : "Report";
  const max = column?.max !== null && column?.max !== undefined ? ` /${formatNumber(column.max)}` : "";
  return { kind, title: column?.short_title || column?.title || "", full: `${kind}: ${column?.title || ""}${max}` };
}

/** Class summary chips for a batch gradebook. */
export function batchSummary(rows = []) {
  const overall = rows.map((row) => row.totals?.overall_percentage).filter((value) => value !== null && value !== undefined);
  const average = overall.length ? Math.round((overall.reduce((sum, value) => sum + Number(value), 0) / overall.length) * 10) / 10 : null;
  return [
    { id: "students", label: "Students", value: rows.length },
    { id: "average", label: "Average overall", value: formatPercent(average), accent: true },
    { id: "missing", label: "Missing", value: rows.reduce((sum, row) => sum + (row.totals?.missing_count || 0), 0) },
    { id: "late", label: "Late", value: rows.reduce((sum, row) => sum + (row.totals?.late_count || 0), 0) },
  ];
}

/** Summary chips for one student's course section. */
export function sectionSummary(totals) {
  return [
    { id: "reports", label: "Reports", value: formatPercent(totals?.reports?.percentage) },
    { id: "exams", label: "Exams", value: formatPercent(totals?.exams?.percentage) },
    { id: "overall", label: "Overall", value: formatPercent(totals?.overall_percentage), accent: true },
  ];
}
