// Pure helpers for the weekly-target editor (form <-> API payload).
import {
  addDaysIso,
  formatMarks,
  fromHundredths,
  fromIstInputValue,
  REPORT_EXTENSIONS,
  toHundredths,
  toIstInputValue,
} from "./reportModel";

let criterionKey = 1;
export const newCriterion = (values = {}) => ({
  key: `criterion-${criterionKey++}`,
  name: "",
  description: "",
  max_marks: "",
  ...values,
});

export function emptyTaskForm(courseId = "", weekNumber = "") {
  return {
    course: courseId ? String(courseId) : "",
    section: "",
    week_number: weekNumber ? String(weekNumber) : "",
    title: "",
    brief: "",
    opens_at: "",
    due_at: "",
    late_policy: "no_late",
    late_until: "",
    late_penalty_percent_per_day: "0",
    max_marks: "10",
    allowed_file_types: [],
    max_files: "5",
    max_file_size_mb: "50",
    max_total_size_mb: "200",
    marks_visibility: "on_grade",
    criteria: [],
  };
}

/** API task -> form values (dates as IST datetime-local strings). */
export function taskToForm(task) {
  return {
    course: String(task.course ?? ""),
    section: task.section ? String(task.section) : "",
    week_number: task.week_number ? String(task.week_number) : "",
    title: task.title || "",
    brief: task.brief || "",
    opens_at: toIstInputValue(task.opens_at),
    due_at: toIstInputValue(task.due_at),
    late_policy: task.late_policy || "no_late",
    late_until: toIstInputValue(task.late_until),
    late_penalty_percent_per_day: formatMarks(task.late_penalty_percent_per_day) || "0",
    max_marks: formatMarks(task.max_marks) || "10",
    allowed_file_types: [...(task.allowed_file_types || [])],
    max_files: String(task.max_files ?? 5),
    max_file_size_mb: String(task.max_file_size_mb ?? 50),
    max_total_size_mb: String(task.max_total_size_mb ?? 200),
    marks_visibility: task.marks_visibility || "on_grade",
    criteria: (task.criteria || []).map((item) =>
      newCriterion({ name: item.name, description: item.description || "", max_marks: formatMarks(item.max_marks) })
    ),
  };
}

/** "Duplicate last week": same target settings, dates a week later, next week number. */
export function copyFromPreviousTask(task) {
  const shift = (value) => (value ? toIstInputValue(addDaysIso(value, 7)) : "");
  return {
    ...taskToForm(task),
    week_number: task.week_number ? String(task.week_number + 1) : "",
    opens_at: shift(task.opens_at),
    due_at: shift(task.due_at),
    late_until: shift(task.late_until),
  };
}

const isWholeNumber = (value) => /^\d+$/.test(String(value ?? "").trim());

/** Field errors keyed like the API (`criteria` for the rubric as a whole). */
export function validateTaskForm(form, { now = Date.now(), isNew = true } = {}) {
  const errors = {};
  if (!form.course) errors.course = "Choose a course.";
  if (!String(form.title || "").trim()) errors.title = "Give the weekly target a title.";
  const due = fromIstInputValue(form.due_at);
  if (!due) errors.due_at = "Choose the deadline.";
  else if (isNew && new Date(due).getTime() <= now) errors.due_at = "Choose a deadline in the future.";
  const opens = form.opens_at ? fromIstInputValue(form.opens_at) : null;
  if (form.opens_at && !opens) errors.opens_at = "Enter a valid date and time.";
  if (opens && due && new Date(opens) >= new Date(due)) errors.opens_at = "The report must open before it is due.";
  if (form.late_policy === "allow_late") {
    const lateUntil = fromIstInputValue(form.late_until);
    if (!lateUntil) errors.late_until = "Choose until when late reports are accepted.";
    else if (due && new Date(lateUntil) <= new Date(due)) errors.late_until = "The late cut-off must be after the deadline.";
    const penalty = Number(form.late_penalty_percent_per_day);
    if (!/^\d+(\.\d{1,2})?$/.test(String(form.late_penalty_percent_per_day ?? "").trim()) || penalty < 0 || penalty > 100) {
      errors.late_penalty_percent_per_day = "Enter a percentage from 0 to 100.";
    }
  }
  const maxMarks = toHundredths(form.max_marks);
  if (maxMarks === null || maxMarks <= 0) errors.max_marks = "Enter the maximum marks, such as 10 or 7.5.";
  if (form.week_number && (!isWholeNumber(form.week_number) || Number(form.week_number) < 1)) {
    errors.week_number = "Use a whole number, such as 3.";
  }
  [
    ["max_files", 1, 20, "Between 1 and 20 files."],
    ["max_file_size_mb", 1, 200, "Between 1 and 200 MB."],
    ["max_total_size_mb", 1, 4000, "Between 1 and 4000 MB."],
  ].forEach(([field, min, max, message]) => {
    const value = Number(form[field]);
    if (!isWholeNumber(form[field]) || value < min || value > max) errors[field] = message;
  });
  if (!errors.max_total_size_mb && !errors.max_file_size_mb && Number(form.max_total_size_mb) < Number(form.max_file_size_mb)) {
    errors.max_total_size_mb = "The total limit must be at least the per-file limit.";
  }
  if (form.criteria.length) {
    let total = 0;
    form.criteria.forEach((criterion, index) => {
      if (!String(criterion.name || "").trim()) errors[`criteria.${index}.name`] = "Name this criterion.";
      const marks = toHundredths(criterion.max_marks);
      if (marks === null || marks <= 0) errors[`criteria.${index}.max_marks`] = "Enter its marks.";
      else total += marks;
    });
    if (maxMarks !== null && !Object.keys(errors).some((key) => key.startsWith("criteria.")) && total !== maxMarks) {
      errors.criteria = `The rubric adds up to ${fromHundredths(total)} but the report is out of ${fromHundredths(maxMarks)}.`;
    }
  }
  return errors;
}

/** Form values -> API payload (ISO dates with the IST offset). */
export function formToPayload(form) {
  const allowed = form.allowed_file_types.length === REPORT_EXTENSIONS.length ? [] : form.allowed_file_types;
  return {
    course: Number(form.course),
    section: form.section ? Number(form.section) : null,
    week_number: form.week_number ? Number(form.week_number) : null,
    title: String(form.title || "").trim(),
    brief: form.brief || "",
    opens_at: form.opens_at ? fromIstInputValue(form.opens_at) : null,
    due_at: fromIstInputValue(form.due_at),
    late_policy: form.late_policy,
    late_until: form.late_policy === "allow_late" ? fromIstInputValue(form.late_until) : null,
    late_penalty_percent_per_day: form.late_policy === "allow_late" ? String(form.late_penalty_percent_per_day || "0") : "0",
    max_marks: String(form.max_marks).trim(),
    allowed_file_types: allowed,
    max_files: Number(form.max_files),
    max_file_size_mb: Number(form.max_file_size_mb),
    max_total_size_mb: Number(form.max_total_size_mb),
    marks_visibility: form.marks_visibility,
    criteria: form.criteria.map((item) => ({
      name: String(item.name || "").trim(),
      description: String(item.description || "").trim(),
      max_marks: String(item.max_marks).trim(),
    })),
  };
}

/** Rubric running total for the editor ("6.5 of 10"). */
export function rubricSum(criteria = []) {
  const total = criteria.reduce((sum, item) => sum + (toHundredths(item.max_marks) || 0), 0);
  return fromHundredths(total);
}
