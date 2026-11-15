import "../features/reports/Reports.scss";

import { Add, ArrowLeft, Copy, Save, Send, TrashCan, Upload } from "@carbon/icons-react";
import {
  Button,
  Checkbox,
  InlineLoading,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  TextArea,
  TextInput,
} from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PageHeader, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import { FileCard } from "../features/reports/FilePreview";
import Markdown from "../features/reports/markdown";
import {
  createManageTask,
  deleteManageTask,
  deleteTaskAttachment,
  getManageTask,
  listGradableCourses,
  listManageTasks,
  publishTask,
  updateManageTask,
  uploadTaskAttachment,
} from "../features/reports/reportsApi";
import { FILE_TYPE_GROUPS, formatMarks, REPORT_EXTENSIONS } from "../features/reports/reportModel";
import {
  copyFromPreviousTask,
  emptyTaskForm,
  formToPayload,
  newCriterion,
  rubricSum,
  taskToForm,
  validateTaskForm,
} from "../features/reports/taskForm";
import { apiData, apiMessage } from "../utils/api";

function selectedExtensions(form) {
  return form.allowed_file_types.length ? form.allowed_file_types : REPORT_EXTENSIONS;
}

function serverErrors(error) {
  const errors = error?.response?.data?.errors;
  if (!errors || typeof errors !== "object") return {};
  const result = {};
  Object.entries(errors).forEach(([key, value]) => {
    if (["detail", "code", "request_id"].includes(key)) return;
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string") result[key] = first;
  });
  return result;
}

export default function ReportsTaskEditorPage() {
  const { taskId } = useParams();
  const isNew = !taskId;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [courses, setCourses] = useState([]);
  const [task, setTask] = useState(null);
  const [form, setForm] = useState(() => emptyTaskForm(params.get("course") || ""));
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [copying, setCopying] = useState(false);
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listGradableCourses(), isNew ? Promise.resolve(null) : getManageTask(taskId)])
      .then(([courseResponse, taskResponse]) => {
        if (cancelled) return;
        const items = apiData(courseResponse, {})?.results || [];
        setCourses(items);
        if (taskResponse) {
          const loaded = apiData(taskResponse, null);
          setTask(loaded);
          setForm(taskToForm(loaded));
        } else {
          setForm((current) => {
            const courseId = current.course || String(items[0]?.id || "");
            const course = items.find((item) => String(item.id) === courseId);
            return { ...current, course: courseId, week_number: course ? String(course.next_week_number) : "" };
          });
        }
        setLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(apiMessage(error, "Please try again."));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isNew, taskId]);

  const course = useMemo(() => courses.find((item) => String(item.id) === form.course), [courses, form.course]);
  const locked = Boolean(task?.has_grades);
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event?.target ? event.target.value : event }));

  const copyLastWeek = useCallback(async () => {
    if (!form.course) return;
    setCopying(true);
    try {
      const response = await listManageTasks({ course: form.course });
      const latest = [...(apiData(response, {})?.results || [])].sort((a, b) => new Date(b.due_at) - new Date(a.due_at))[0];
      if (!latest) {
        showToast({ kind: "info", title: "No earlier target to copy in this course." });
        return;
      }
      setForm(copyFromPreviousTask(latest));
      setErrors({});
      showToast({ kind: "success", title: `Copied “${latest.title}”`, subtitle: "Dates moved one week later. Update the target." });
    } catch (error) {
      showToast({ kind: "error", title: "Couldn't copy last week", subtitle: apiMessage(error) });
    } finally {
      setCopying(false);
    }
  }, [form.course, showToast]);

  const toggleGroup = (group, checked) => {
    setForm((current) => {
      const selected = new Set(selectedExtensions(current));
      group.extensions.forEach((ext) => (checked ? selected.add(ext) : selected.delete(ext)));
      const list = REPORT_EXTENSIONS.filter((ext) => selected.has(ext));
      return { ...current, allowed_file_types: list.length === REPORT_EXTENSIONS.length ? [] : list };
    });
  };

  const save = async ({ publish = false } = {}) => {
    const validation = validateTaskForm(form, { isNew: isNew || task?.status === "draft" });
    if (!selectedExtensions(form).length) validation.allowed_file_types = "Allow at least one file type.";
    setErrors(validation);
    setSaveError("");
    if (Object.keys(validation).length) {
      setSaveError("Check the highlighted fields.");
      return;
    }
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (!isNew) {
        delete payload.course;
        if (locked) {
          delete payload.max_marks;
          delete payload.criteria;
        }
      }
      const response = isNew ? await createManageTask(payload) : await updateManageTask(taskId, payload);
      let saved = apiData(response, {});
      if (publish) {
        saved = apiData(await publishTask(saved.id), saved);
        showToast({ kind: "success", title: "Published", subtitle: "Students have been notified." });
        navigate(`/report-grading?course=${saved.course}`);
        return;
      }
      showToast({ kind: "success", title: isNew ? "Draft saved" : "Changes saved" });
      if (isNew) navigate(`/report-grading/tasks/${saved.id}/edit`, { replace: true });
      else {
        setTask(saved);
        setForm(taskToForm(saved));
      }
    } catch (error) {
      setErrors(serverErrors(error));
      setSaveError(apiMessage(error, "Not saved. Try again."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await deleteManageTask(taskId);
      showToast({ kind: "success", title: "Draft deleted" });
      navigate(`/report-grading?course=${task.course}`);
    } catch (error) {
      setSaveError(apiMessage(error));
      setSaving(false);
    }
  };

  const addAttachment = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      await uploadTaskAttachment(taskId, file);
      const refreshed = apiData(await getManageTask(taskId), task);
      setTask(refreshed);
      showToast({ kind: "success", title: "Reference file added" });
    } catch (error) {
      showToast({ kind: "error", title: "Upload failed", subtitle: apiMessage(error) });
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (attachment) => {
    try {
      await deleteTaskAttachment(attachment.id);
      setTask((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id) }));
    } catch (error) {
      showToast({ kind: "error", title: "Couldn't remove it", subtitle: apiMessage(error) });
    }
  };

  const setCriterion = (index, field, value) =>
    setForm((current) => ({
      ...current,
      criteria: current.criteria.map((item, itemIndex) => (itemIndex === index ? { ...item, [field]: value } : item)),
    }));

  if (loading) return <PageSkeleton label="Loading" count={2} />;
  if (loadError) return <PageNotification kind="error" title="Couldn't open this weekly target." subtitle={loadError} />;

  const extensions = selectedExtensions(form);
  const backHref = `/report-grading${form.course ? `?course=${form.course}` : ""}`;

  return (
    <div className="rpt-editor">
      <Link to={backHref} className="rpt-back">
        <ArrowLeft size={16} aria-hidden="true" /> Report grading
      </Link>
      <PageHeader
        title={isNew ? "New weekly target" : "Edit weekly target"}
        description={isNew ? "One target per week: what students investigate and how it's marked." : `${task?.course_title} · ${task?.status}`}
        actions={
          isNew ? (
            <Button kind="tertiary" renderIcon={Copy} onClick={copyLastWeek} disabled={copying || !form.course}>
              {copying ? "Copying…" : "Copy last week's target"}
            </Button>
          ) : null
        }
      />
      <form
        className="rpt-editor__form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <section className="rpt-card rpt-editor__section">
          <h2 className="rpt-card__title">Target</h2>
          <div className="rpt-editor__row">
            <Select id="rpt-task-course" labelText="Course" value={form.course} onChange={(event) => { const value = event.target.value; const next = courses.find((item) => String(item.id) === value); setForm((current) => ({ ...current, course: value, section: "", week_number: next ? String(next.next_week_number) : current.week_number })); }} disabled={!isNew} invalid={Boolean(errors.course)} invalidText={errors.course}>
              <SelectItem value="" text="Choose a course" />
              {courses.map((item) => (
                <SelectItem key={item.id} value={String(item.id)} text={item.title} />
              ))}
            </Select>
            <Select id="rpt-task-section" labelText="Module (optional)" value={form.section} onChange={set("section")} invalid={Boolean(errors.section)} invalidText={errors.section}>
              <SelectItem value="" text="No module" />
              {(course?.sections || []).map((section) => (
                <SelectItem key={section.id} value={String(section.id)} text={section.title} />
              ))}
            </Select>
            <TextInput id="rpt-task-week" labelText="Week" inputMode="numeric" value={form.week_number} onChange={set("week_number")} invalid={Boolean(errors.week_number)} invalidText={errors.week_number} />
          </div>
          <TextInput
            id="rpt-task-title"
            labelText="Target (title)"
            placeholder="e.g. Trace the people behind example-shop.in"
            value={form.title}
            maxCount={200}
            onChange={set("title")}
            invalid={Boolean(errors.title)}
            invalidText={errors.title}
          />
          <div className="rpt-editor__brief">
            <TextArea
              id="rpt-task-brief"
              labelText="Brief and instructions (Markdown)"
              helperText="Headings (#), lists (-), **bold**, links and tables are supported."
              rows={8}
              value={form.brief}
              onChange={set("brief")}
              invalid={Boolean(errors.brief)}
              invalidText={errors.brief}
            />
            <Button kind="ghost" size="sm" onClick={() => setShowPreview((value) => !value)} aria-pressed={showPreview}>
              {showPreview ? "Hide preview" : "Preview brief"}
            </Button>
            {showPreview ? <div className="rpt-editor__preview">{form.brief ? <Markdown text={form.brief} /> : <p className="rpt-muted">Nothing to preview.</p>}</div> : null}
          </div>
        </section>

        <section className="rpt-card rpt-editor__section">
          <h2 className="rpt-card__title">Deadline (India time, IST)</h2>
          <div className="rpt-editor__row">
            <TextInput id="rpt-task-opens" type="datetime-local" labelText="Opens (optional)" helperText="Empty: visible as soon as you publish." value={form.opens_at} onChange={set("opens_at")} invalid={Boolean(errors.opens_at)} invalidText={errors.opens_at} />
            <TextInput id="rpt-task-due" type="datetime-local" labelText="Due" value={form.due_at} onChange={set("due_at")} invalid={Boolean(errors.due_at)} invalidText={errors.due_at} />
          </div>
          <RadioButtonGroup legendText="Late submissions" name="rpt-late-policy" valueSelected={form.late_policy} onChange={(value) => setForm((current) => ({ ...current, late_policy: value }))} orientation="vertical">
            <RadioButton id="rpt-late-no" value="no_late" labelText="Not accepted after the deadline" />
            <RadioButton id="rpt-late-yes" value="allow_late" labelText="Accepted until a cut-off, marked late" />
          </RadioButtonGroup>
          {form.late_policy === "allow_late" ? (
            <div className="rpt-editor__row">
              <TextInput id="rpt-task-late-until" type="datetime-local" labelText="Accept late reports until" value={form.late_until} onChange={set("late_until")} invalid={Boolean(errors.late_until)} invalidText={errors.late_until} />
              <TextInput
                id="rpt-task-penalty"
                labelText="Penalty per day late (% of max marks)"
                helperText="0 for no penalty. Each started day counts."
                inputMode="decimal"
                value={form.late_penalty_percent_per_day}
                onChange={set("late_penalty_percent_per_day")}
                invalid={Boolean(errors.late_penalty_percent_per_day)}
                invalidText={errors.late_penalty_percent_per_day}
              />
            </div>
          ) : null}
        </section>

        <section className="rpt-card rpt-editor__section">
          <h2 className="rpt-card__title">Marks</h2>
          {locked ? (
            <InlineNotification kind="info" lowContrast hideCloseButton title="Marks have been given." subtitle="The maximum marks and rubric can't change any more." />
          ) : null}
          <TextInput id="rpt-task-max" labelText="Maximum marks" inputMode="decimal" value={form.max_marks} onChange={set("max_marks")} disabled={locked} invalid={Boolean(errors.max_marks)} invalidText={errors.max_marks} />
          <fieldset className="rpt-editor__rubric">
            <legend className="rpt-grade-form__legend">Rubric (optional)</legend>
            {form.criteria.map((criterion, index) => (
              <div key={criterion.key} className="rpt-editor__criterion">
                <TextInput id={`rpt-crit-name-${criterion.key}`} labelText={`Criterion ${index + 1}`} value={criterion.name} disabled={locked} onChange={(event) => setCriterion(index, "name", event.target.value)} invalid={Boolean(errors[`criteria.${index}.name`])} invalidText={errors[`criteria.${index}.name`]} />
                <TextInput id={`rpt-crit-max-${criterion.key}`} labelText="Marks" inputMode="decimal" value={criterion.max_marks} disabled={locked} onChange={(event) => setCriterion(index, "max_marks", event.target.value)} invalid={Boolean(errors[`criteria.${index}.max_marks`])} invalidText={errors[`criteria.${index}.max_marks`]} />
                <TextInput id={`rpt-crit-desc-${criterion.key}`} labelText="What earns the marks (optional)" value={criterion.description} disabled={locked} onChange={(event) => setCriterion(index, "description", event.target.value)} />
                <Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription={`Remove criterion ${index + 1}`} disabled={locked} onClick={() => setForm((current) => ({ ...current, criteria: current.criteria.filter((_item, itemIndex) => itemIndex !== index) }))} />
              </div>
            ))}
            {form.criteria.length ? (
              <p className={`rpt-editor__sum${errors.criteria ? " rpt-editor__sum--error" : ""}`} role={errors.criteria ? "alert" : undefined}>
                Rubric total {rubricSum(form.criteria)} of {formatMarks(form.max_marks) || "?"}
                {errors.criteria ? ` · ${errors.criteria}` : ""}
              </p>
            ) : null}
            <Button kind="ghost" size="sm" renderIcon={Add} disabled={locked || form.criteria.length >= 20} onClick={() => setForm((current) => ({ ...current, criteria: [...current.criteria, newCriterion()] }))}>
              Add criterion
            </Button>
          </fieldset>
          <RadioButtonGroup legendText="When students see their marks" name="rpt-visibility" valueSelected={form.marks_visibility} onChange={(value) => setForm((current) => ({ ...current, marks_visibility: value }))} orientation="vertical">
            <RadioButton id="rpt-vis-grade" value="on_grade" labelText="As soon as each report is marked" />
            <RadioButton id="rpt-vis-release" value="on_release" labelText="All together, when I release them" />
          </RadioButtonGroup>
        </section>

        <section className="rpt-card rpt-editor__section">
          <h2 className="rpt-card__title">Files students can send</h2>
          <fieldset className="rpt-editor__types">
            <legend className="rpt-grade-form__legend">Allowed file types</legend>
            {FILE_TYPE_GROUPS.map((group) => (
              <Checkbox
                key={group.id}
                id={`rpt-type-${group.id}`}
                labelText={group.label}
                checked={group.extensions.every((ext) => extensions.includes(ext))}
                onChange={(_event, { checked }) => toggleGroup(group, checked)}
              />
            ))}
            {errors.allowed_file_types ? <p className="rpt-editor__sum rpt-editor__sum--error">{errors.allowed_file_types}</p> : null}
          </fieldset>
          <div className="rpt-editor__row">
            <TextInput id="rpt-task-files" labelText="Max files" inputMode="numeric" value={form.max_files} onChange={set("max_files")} invalid={Boolean(errors.max_files)} invalidText={errors.max_files} />
            <TextInput id="rpt-task-size" labelText="Max size per file (MB)" inputMode="numeric" value={form.max_file_size_mb} onChange={set("max_file_size_mb")} invalid={Boolean(errors.max_file_size_mb)} invalidText={errors.max_file_size_mb} />
            <TextInput id="rpt-task-total" labelText="Max total (MB)" inputMode="numeric" value={form.max_total_size_mb} onChange={set("max_total_size_mb")} invalid={Boolean(errors.max_total_size_mb)} invalidText={errors.max_total_size_mb} />
          </div>
        </section>

        {!isNew ? (
          <section className="rpt-card rpt-editor__section">
            <h2 className="rpt-card__title">Reference files (optional)</h2>
            <p className="rpt-muted">Sample reports, templates or starting points students can download.</p>
            {task?.attachments?.length ? (
              <ul className="rpt-files">
                {task.attachments.map((attachment) => (
                  <FileCard
                    key={attachment.id}
                    file={{ ...attachment, source: "attachment" }}
                    actions={<Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription={`Remove ${attachment.name}`} onClick={() => removeAttachment(attachment)} />}
                  />
                ))}
              </ul>
            ) : null}
            <input ref={attachmentInput} type="file" className="rpt-visually-hidden" aria-label="Reference file" onChange={(event) => { addAttachment(event.target.files?.[0]); event.target.value = ""; }} />
            {uploading ? <InlineLoading description="Uploading…" /> : (
              <Button kind="tertiary" size="sm" renderIcon={Upload} onClick={() => attachmentInput.current?.click()}>
                Add reference file
              </Button>
            )}
          </section>
        ) : null}

        {saveError ? <InlineNotification kind="error" lowContrast className="rpt-banner" title="Not saved." subtitle={saveError} onClose={() => setSaveError("")} role="alert" /> : null}
        <div className="rpt-editor__actions">
          {isNew || task?.status === "draft" ? (
            <>
              <Button kind="primary" renderIcon={Send} disabled={saving} onClick={() => save({ publish: true })}>
                Save & publish
              </Button>
              <Button kind="secondary" type="submit" renderIcon={Save} disabled={saving}>
                Save draft
              </Button>
            </>
          ) : (
            <Button kind="primary" type="submit" renderIcon={Save} disabled={saving}>
              Save changes
            </Button>
          )}
          {!isNew && task?.status === "draft" && !task?.counts?.submitted ? (
            <Button kind="danger--ghost" renderIcon={TrashCan} disabled={saving} onClick={remove}>
              Delete draft
            </Button>
          ) : null}
          {saving ? <InlineLoading description="Saving…" /> : null}
        </div>
      </form>
    </div>
  );
}
