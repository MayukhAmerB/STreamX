import { Attachment, Checkmark, Save, TrashCan, Undo } from "@carbon/icons-react";
import { Button, InlineNotification, TextArea, TextInput } from "@carbon/react";
import { useMemo, useRef, useState } from "react";
import {
  formatMarks,
  formatMinutesLate,
  latePenalty,
  rubricTotal,
  validateMarksInput,
} from "./reportModel";

/** Initial form values from the stored grade. */
export function initialGradingValues(detail) {
  const grade = detail?.grade;
  const criteria = {};
  (grade?.criteria || []).forEach((item) => {
    criteria[String(item.id)] = item.marks === null || item.marks === undefined ? "" : formatMarks(item.marks);
  });
  const feedback =
    detail?.status === "returned_for_revision" ? grade?.revision_feedback || "" : grade?.feedback || "";
  return {
    marks: grade?.raw_marks === null || grade?.raw_marks === undefined ? "" : formatMarks(grade.raw_marks),
    criteria,
    feedback,
  };
}

/**
 * Validates the form for an action ("draft" | "grade" | "return").
 * Returns { errors, valid, payload } where payload is ready for the API.
 */
export function buildGradePayload(detail, values, action) {
  const task = detail?.task || {};
  const criteria = task.criteria || [];
  const required = action === "grade";
  const errors = {};
  const payload = { action, expected_revision: detail?.revision ?? 0, feedback: String(values.feedback || "").trim() };
  if (action !== "return") {
    if (criteria.length) {
      const marks = {};
      criteria.forEach((criterion) => {
        const value = values.criteria?.[String(criterion.id)] ?? "";
        const error = validateMarksInput(value, criterion.max_marks, { required });
        if (error) errors[`criteria.${criterion.id}`] = error;
        else if (String(value).trim()) marks[String(criterion.id)] = String(value).trim();
      });
      payload.criteria_marks = marks;
    } else {
      const error = validateMarksInput(values.marks, task.max_marks, { required });
      if (error) errors.marks = error;
      else if (String(values.marks ?? "").trim()) payload.marks = String(values.marks).trim();
    }
  } else if (!payload.feedback) {
    errors.feedback = "Tell the student what to fix before returning the report.";
  }
  return { errors, valid: Object.keys(errors).length === 0, payload };
}

/** Marks / rubric / feedback form for one submission (keyed by id + revision by the parent). */
export default function GradingForm({ detail, saving = false, error = "", conflict = false, hasNext = false, onSubmit, onReload }) {
  const [values, setValues] = useState(() => initialGradingValues(detail));
  const [errors, setErrors] = useState({});
  const [annotatedFile, setAnnotatedFile] = useState(null);
  const [removeAnnotated, setRemoveAnnotated] = useState(false);
  const fileInput = useRef(null);
  const task = detail?.task || {};
  const criteria = task.criteria || [];
  const existingAnnotated = detail?.grade?.annotated_file;

  const raw = criteria.length ? rubricTotal(criteria, values.criteria) : validateMarksInput(values.marks, task.max_marks) ? null : formatMarks(values.marks);
  const penalty = useMemo(
    () =>
      latePenalty({
        rawMarks: raw,
        maxMarks: task.max_marks,
        minutesLate: detail?.current_version?.minutes_late ?? detail?.minutes_late,
        percentPerDay: task.late_penalty_percent_per_day,
      }),
    [raw, task.max_marks, task.late_penalty_percent_per_day, detail?.current_version?.minutes_late, detail?.minutes_late]
  );
  const minutesLate = detail?.current_version?.minutes_late ?? detail?.minutes_late ?? 0;

  const submit = (action, { andNext = false } = {}) => {
    const result = buildGradePayload(detail, values, action);
    setErrors(result.errors);
    if (!result.valid) return;
    onSubmit?.(
      {
        ...result.payload,
        ...(annotatedFile ? { annotatedFile } : {}),
        ...(removeAnnotated && !annotatedFile ? { remove_annotated_file: true } : {}),
      },
      { andNext }
    );
  };

  const setCriterion = (id, value) =>
    setValues((current) => ({ ...current, criteria: { ...current.criteria, [String(id)]: value } }));

  return (
    <form
      className="rpt-grade-form"
      noValidate
      aria-label={`Marks for ${detail?.student?.full_name || detail?.student?.email || "this student"}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit("grade", { andNext: hasNext });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          submit("grade", { andNext: hasNext });
        }
      }}
    >
      {conflict ? (
        <div className="rpt-grade-form__conflict">
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Someone else changed this submission."
            subtitle="Your marks were not saved, so nothing was overwritten."
          />
          <Button kind="tertiary" size="sm" onClick={onReload}>
            Load the latest version
          </Button>
        </div>
      ) : null}
      {error && !conflict ? <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved." subtitle={error} role="alert" /> : null}

      {criteria.length ? (
        <fieldset className="rpt-grade-form__rubric">
          <legend className="rpt-grade-form__legend">Rubric</legend>
          {criteria.map((criterion) => (
            <div key={criterion.id} className="rpt-grade-form__criterion">
              <TextInput
                id={`rpt-criterion-${criterion.id}`}
                labelText={`${criterion.name} (out of ${formatMarks(criterion.max_marks)})`}
                helperText={criterion.description || undefined}
                inputMode="decimal"
                autoComplete="off"
                value={values.criteria[String(criterion.id)] ?? ""}
                invalid={Boolean(errors[`criteria.${criterion.id}`])}
                invalidText={errors[`criteria.${criterion.id}`]}
                onChange={(event) => setCriterion(criterion.id, event.target.value)}
              />
            </div>
          ))}
        </fieldset>
      ) : (
        <TextInput
          id="rpt-marks"
          labelText={`Marks (out of ${formatMarks(task.max_marks)})`}
          inputMode="decimal"
          autoComplete="off"
          value={values.marks}
          invalid={Boolean(errors.marks)}
          invalidText={errors.marks}
          onChange={(event) => setValues((current) => ({ ...current, marks: event.target.value }))}
        />
      )}

      <dl className="rpt-grade-form__summary" aria-live="polite">
        <div>
          <dt>Total</dt>
          <dd>
            {raw === null ? "–" : raw} / {formatMarks(task.max_marks)}
          </dd>
        </div>
        {minutesLate > 0 && Number(task.late_penalty_percent_per_day) > 0 ? (
          <div>
            <dt>Late penalty</dt>
            <dd>
              {penalty.penalty === null ? "–" : `−${penalty.penalty}`}{" "}
              <span className="rpt-muted">
                ({formatMinutesLate(minutesLate)}, {formatMarks(task.late_penalty_percent_per_day)}%/day)
              </span>
            </dd>
          </div>
        ) : null}
        <div className="rpt-grade-form__final">
          <dt>Final marks</dt>
          <dd>
            {penalty.final === null ? "–" : penalty.final} / {formatMarks(task.max_marks)}
          </dd>
        </div>
      </dl>

      <TextArea
        id="rpt-feedback"
        labelText="Feedback for the student"
        helperText="Shown with the marks. Required when you return the report for revision."
        rows={5}
        maxCount={10000}
        enableCounter
        value={values.feedback}
        invalid={Boolean(errors.feedback)}
        invalidText={errors.feedback}
        onChange={(event) => setValues((current) => ({ ...current, feedback: event.target.value }))}
      />

      <div className="rpt-grade-form__attach">
        <input
          ref={fileInput}
          type="file"
          className="rpt-visually-hidden"
          aria-label="Marked-up file for the student"
          onChange={(event) => {
            setAnnotatedFile(event.target.files?.[0] || null);
            setRemoveAnnotated(false);
            event.target.value = "";
          }}
        />
        {annotatedFile ? (
          <p className="rpt-grade-form__file">
            <Attachment size={16} aria-hidden="true" /> {annotatedFile.name} (will be sent)
            <Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription="Don't attach" onClick={() => setAnnotatedFile(null)} />
          </p>
        ) : existingAnnotated && !removeAnnotated ? (
          <p className="rpt-grade-form__file">
            <Attachment size={16} aria-hidden="true" /> {existingAnnotated.name}
            <Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription="Remove the marked-up file" onClick={() => setRemoveAnnotated(true)} />
          </p>
        ) : null}
        <Button kind="ghost" size="sm" renderIcon={Attachment} onClick={() => fileInput.current?.click()} disabled={saving}>
          {existingAnnotated || annotatedFile ? "Replace marked-up file" : "Attach marked-up file (optional)"}
        </Button>
      </div>

      <div className="rpt-grade-form__actions">
        <Button type="submit" kind="primary" renderIcon={Checkmark} disabled={saving}>
          {hasNext ? "Save & next" : "Save marks"}
        </Button>
        {hasNext ? (
          <Button kind="secondary" renderIcon={Save} disabled={saving} onClick={() => submit("grade")}>
            Save marks
          </Button>
        ) : null}
        <Button kind="tertiary" disabled={saving} onClick={() => submit("draft")}>
          Save draft
        </Button>
        <Button kind="danger--tertiary" renderIcon={Undo} disabled={saving} onClick={() => submit("return")}>
          Return for revision
        </Button>
      </div>
      <p className="rpt-grade-form__hint">
        Ctrl + Enter saves{hasNext ? " and opens the next ungraded report" : ""}. Drafts stay hidden from the student.
      </p>
    </form>
  );
}
