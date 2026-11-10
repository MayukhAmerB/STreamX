import "../features/reports/Reports.scss";

import { ArrowLeft, CheckmarkFilled, Renew, Report, Send } from "@carbon/icons-react";
import { Button, InlineLoading, InlineNotification, Modal, TextArea } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { EmptyState, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import FilePreview, { FileList } from "../features/reports/FilePreview";
import Markdown from "../features/reports/markdown";
import { ReportUploaderView, useReportUploads } from "../features/reports/ReportUploader";
import { getReportTask, newIdempotencyKey, submitReport } from "../features/reports/reportsApi";
import {
  describeExtensions,
  describeLatePolicy,
  formatBytes,
  formatIst,
  formatMarks,
  formatMinutesLate,
  getCountdown,
  receiptId,
} from "../features/reports/reportModel";
import StatusChip, { LateChip } from "../features/reports/StatusChip";
import useNow from "../features/reports/useNow";
import { apiData, apiMessage } from "../utils/api";
import { taskMeta } from "./ReportsPage";

const withSource = (files = [], source = "submission", extra = {}) => files.map((file) => ({ ...file, source, ...extra }));

function usePreview() {
  const [file, setFile] = useState(null);
  const key = file ? `${file.source || "submission"}-${file.id}` : "";
  const toggle = useCallback((next) => setFile((current) => (current && current.id === next.id && current.source === next.source ? null : next)), []);
  return { file, key, toggle, close: () => setFile(null) };
}

function PreviewableFiles({ files, label }) {
  const preview = usePreview();
  if (!files.length) return null;
  return (
    <>
      <FileList files={files} selectedKey={preview.key} onPreview={preview.toggle} label={label} />
      {preview.file ? <FilePreview file={preview.file} onClose={preview.close} /> : null}
    </>
  );
}

function DeadlineFacts({ task, now }) {
  const countdown = getCountdown(task.due_at, now);
  return (
    <dl className="rpt-facts">
      <div>
        <dt>Due</dt>
        <dd>
          {formatIst(task.due_at)}
          {task.window === "open" ? <span className={`rpt-countdown rpt-countdown--${countdown.tone}`}>{countdown.text}</span> : null}
        </dd>
      </div>
      <div>
        <dt>Late reports</dt>
        <dd>{describeLatePolicy(task)}</dd>
      </div>
      <div>
        <dt>Marks</dt>
        <dd>
          Out of {formatMarks(task.max_marks)}
          {task.marks_visibility === "on_release" ? " · released to everyone together" : " · shown as soon as it's marked"}
        </dd>
      </div>
      <div>
        <dt>Files</dt>
        <dd>
          {describeExtensions(task.allowed_extensions)} · up to {task.max_files} files, {task.max_file_size_mb} MB each
        </dd>
      </div>
    </dl>
  );
}

function GradeCard({ task }) {
  const grade = task.grade;
  const feedbackFile = grade.annotated_file
    ? [{ ...grade.annotated_file, id: task.submission?.id, source: "feedback", submissionId: task.submission?.id }]
    : [];
  return (
    <section className="rpt-card rpt-grade" aria-labelledby="rpt-grade-title">
      <p className="rpt-eyebrow">Your marks</p>
      <h2 id="rpt-grade-title" className="rpt-grade__score">
        {formatMarks(grade.final_marks)}
        <span className="rpt-grade__max">/{formatMarks(grade.max_marks)}</span>
      </h2>
      {Number(grade.late_penalty) > 0 ? (
        <p className="rpt-grade__penalty">
          {formatMarks(grade.raw_marks)} marked, −{formatMarks(grade.late_penalty)} for late submission
        </p>
      ) : null}
      {grade.criteria?.length ? (
        <ul className="rpt-rubric-marks" aria-label="Rubric breakdown">
          {grade.criteria.map((item) => {
            const share = Number(item.max_marks) ? Math.min(100, (Number(item.marks || 0) / Number(item.max_marks)) * 100) : 0;
            return (
              <li key={item.id} className="rpt-rubric-marks__row">
                <span className="rpt-rubric-marks__name">{item.name}</span>
                <span className="rpt-rubric-marks__value">
                  {item.marks === null ? "–" : formatMarks(item.marks)}/{formatMarks(item.max_marks)}
                </span>
                <span className="rpt-rubric-marks__bar" aria-hidden="true">
                  <span style={{ inlineSize: `${share}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {grade.feedback ? (
        <div className="rpt-feedback">
          <h3 className="rpt-subtitle">Feedback</h3>
          <p className="rpt-feedback__text">{grade.feedback}</p>
        </div>
      ) : null}
      {feedbackFile.length ? (
        <div className="rpt-feedback">
          <h3 className="rpt-subtitle">Marked-up file from your instructor</h3>
          <PreviewableFiles files={feedbackFile} label="Marked-up file" />
        </div>
      ) : null}
      {grade.graded_at ? <p className="rpt-muted">Marked {formatIst(grade.graded_at)}</p> : null}
    </section>
  );
}

function Receipt({ task, onReplace }) {
  const submission = task.submission;
  const version = submission.current_version;
  const older = submission.versions.filter((item) => item.id !== version?.id);
  const canReplace = task.can_submit && submission.status !== "returned_for_revision";
  return (
    <section className="rpt-card rpt-receipt" aria-labelledby="rpt-receipt-title">
      <div className="rpt-receipt__head">
        <CheckmarkFilled size={24} aria-hidden="true" className="rpt-receipt__icon" />
        <div>
          <h2 id="rpt-receipt-title" className="rpt-card__title">
            {submission.status === "resubmitted" ? "Resubmitted" : "Submitted"}
          </h2>
          <p className="rpt-muted">
            Receipt {receiptId(submission)} · Version {version?.number} · {formatIst(submission.submitted_at)}
          </p>
        </div>
      </div>
      {submission.is_late ? (
        <p className="rpt-receipt__late">
          <LateChip label="Late" minutesLate={formatMinutesLate(submission.minutes_late).replace(/ late$/, "")} />
        </p>
      ) : null}
      {version?.note ? <p className="rpt-receipt__note">“{version.note}”</p> : null}
      <PreviewableFiles files={withSource(version?.files)} label="Submitted files" />
      {canReplace ? (
        <div className="rpt-receipt__actions">
          <Button kind="tertiary" renderIcon={Renew} onClick={onReplace}>
            Replace files
          </Button>
          <span className="rpt-muted">
            {task.window === "open" ? `You can replace them until ${formatIst(task.due_at)}.` : "Replacing now will be marked late."}
          </span>
        </div>
      ) : null}
      {older.length ? (
        <details className="rpt-history">
          <summary>Version history ({submission.versions.length})</summary>
          <ol className="rpt-history__list">
            {older.map((item) => (
              <li key={item.id}>
                <p className="rpt-history__meta">
                  Version {item.number} · {formatIst(item.submitted_at)}
                  {item.is_late ? ` · ${formatMinutesLate(item.minutes_late)}` : ""}
                  {item.is_revision ? " · revision" : ""}
                </p>
                <PreviewableFiles files={withSource(item.files)} label={`Version ${item.number} files`} />
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

function SubmitConfirmModal({ open, items, note, task, now, submitting, error, onConfirm, onClose }) {
  const late = task.window === "late" && task.status !== "returned_for_revision";
  const lateBy = late ? formatMinutesLate(Math.ceil((now - new Date(task.due_at).getTime()) / 60000)) : "";
  return (
    <Modal
      open={open}
      modalHeading="Submit your report?"
      primaryButtonText={submitting ? "Submitting…" : "Submit report"}
      secondaryButtonText="Back"
      primaryButtonDisabled={submitting}
      onRequestSubmit={onConfirm}
      onRequestClose={submitting ? () => {} : onClose}
      size="sm"
      className="rpt-confirm"
    >
      <p>
        {items.length} file{items.length === 1 ? "" : "s"} for <strong>{task.title}</strong>:
      </p>
      <ul className="rpt-confirm__files">
        {items.map((item) => (
          <li key={item.key}>
            {item.name} <span className="rpt-muted">({formatBytes(item.size)})</span>
          </li>
        ))}
      </ul>
      {note ? <p className="rpt-confirm__note">Note: “{note}”</p> : null}
      {late ? (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="This report will be marked late."
          subtitle={`${lateBy}.${Number(task.late_penalty_percent_per_day) > 0 ? ` ${formatMarks(task.late_penalty_percent_per_day)}% of the marks are taken off per day late.` : ""}`}
        />
      ) : null}
      {task.submission && task.status !== "returned_for_revision" ? (
        <p className="rpt-muted">This replaces your current files. Earlier versions stay in your history.</p>
      ) : null}
      {submitting ? <InlineLoading description="Submitting…" /> : null}
      {error ? <InlineNotification kind="error" lowContrast hideCloseButton title="Not submitted." subtitle={error} role="alert" /> : null}
    </Modal>
  );
}

function SubmitPanel({ task, now, onSubmitted, onCancel, replacing }) {
  const includeCurrent = replacing || task.status === "returned_for_revision";
  const uploads = useReportUploads(task, { includeCurrent });
  const [note, setNote] = useState(task.submission?.current_version?.note || "");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const { showToast } = useToast();
  const rules = {
    allowedExtensions: task.allowed_extensions,
    maxFiles: task.max_files,
    maxFileSizeMb: task.max_file_size_mb,
    maxTotalSizeMb: task.max_total_size_mb,
  };
  const readyItems = uploads.items.filter((item) => item.status === "done" && item.id);
  const canSubmit = readyItems.length > 0 && !uploads.busy && !submitting;

  const open = () => {
    setError("");
    setIdempotencyKey(newIdempotencyKey());
    setConfirming(true);
  };

  const confirm = () => {
    setSubmitting(true);
    setError("");
    submitReport(task.id, { fileIds: uploads.fileIds, note }, idempotencyKey)
      .then((response) => {
        const data = apiData(response, {});
        setConfirming(false);
        showToast({ kind: "success", title: data.created ? "Report submitted" : "Already submitted", subtitle: "Your receipt is below." });
        onSubmitted(data.task);
      })
      .catch((requestError) => {
        setError(apiMessage(requestError, "Check your connection and try again."));
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <section className="rpt-card rpt-submit" aria-labelledby="rpt-submit-title">
      <h2 id="rpt-submit-title" className="rpt-card__title">
        {task.status === "returned_for_revision" ? "Send your revised report" : replacing ? "Replace your files" : "Your report"}
      </h2>
      <p className="rpt-muted">
        {replacing || task.status === "returned_for_revision"
          ? "Keep the files you still want, remove the rest and add new ones."
          : "Add your report files, then submit. You can replace them until the deadline."}
      </p>
      <ReportUploaderView
        items={uploads.items}
        rules={rules}
        rejections={uploads.rejections}
        onPick={(files) => uploads.addFiles(files, rules)}
        onRetry={uploads.retry}
        onRemove={uploads.remove}
        onDismissRejections={uploads.dismissRejections}
        disabled={submitting}
      />
      <TextArea
        id="rpt-note"
        labelText="Short note or summary (optional)"
        helperText="For example, the key findings or anything your instructor should know."
        rows={3}
        maxCount={2000}
        enableCounter
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="rpt-submit__actions">
        <Button kind="primary" renderIcon={Send} disabled={!canSubmit} onClick={open}>
          {task.status === "returned_for_revision" ? "Resubmit report" : "Submit report"}
        </Button>
        {replacing ? (
          <Button kind="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
        <span className="rpt-muted" aria-live="polite">
          {uploads.busy
            ? "Wait for the uploads to finish."
            : uploads.failed
              ? "Retry or remove the files that failed."
              : readyItems.length
                ? `${readyItems.length} file${readyItems.length === 1 ? "" : "s"} ready.`
                : "Add at least one file."}
        </span>
      </div>
      <SubmitConfirmModal
        open={confirming}
        items={readyItems}
        note={note.trim()}
        task={task}
        now={now}
        submitting={submitting}
        error={error}
        onConfirm={confirm}
        onClose={() => setConfirming(false)}
      />
    </section>
  );
}

/** Presentational task page (also used by tests and the screenshot harness). */
export function ReportTaskView({ task, now = Date.now(), onSubmitted }) {
  const [replacing, setReplacing] = useState(false);
  const [lastTask, setLastTask] = useState(task);
  if (lastTask !== task) {
    setLastTask(task);
    setReplacing(false);
  }
  const attachments = useMemo(() => withSource(task.attachments, "attachment"), [task.attachments]);
  const submission = task.submission;
  const showSubmitPanel =
    task.can_submit && (!submission || replacing || task.status === "returned_for_revision");

  return (
    <article className="rpt-task">
      <Link to="/reports" className="rpt-back">
        <ArrowLeft size={16} aria-hidden="true" /> All reports
      </Link>
      <header className="rpt-task__header">
        <p className="rpt-eyebrow">{taskMeta(task)}</p>
        <h1 className="rpt-task__title">{task.title}</h1>
        <div className="rpt-task__chips">
          <StatusChip item={task} />
          {task.is_late && task.status !== "submitted" ? <LateChip minutesLate={formatMinutesLate(task.minutes_late).replace(/ late$/, "")} /> : null}
        </div>
        <p className="rpt-muted rpt-task__due">
          Due {formatIst(task.due_at)}
          {task.window === "open" ? ` · ${getCountdown(task.due_at, now).text.replace(/^Due in/, "in")}` : ""}
        </p>
      </header>

      {task.status === "returned_for_revision" ? (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          className="rpt-banner"
          title="Returned for revision"
          subtitle={task.revision_feedback || "Your instructor asked for changes."}
        />
      ) : null}
      {task.status === "resubmitted" && task.revision_feedback ? (
        <InlineNotification kind="info" lowContrast hideCloseButton className="rpt-banner" title="What your instructor asked for" subtitle={task.revision_feedback} />
      ) : null}
      {task.marks_hidden_until_release ? (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          className="rpt-banner"
          title="Your report has been marked."
          subtitle="Marks for this week are released to everyone together. You'll get a notification."
        />
      ) : null}

      <div className="rpt-task__grid">
        <div className="rpt-task__main">
          {task.grade ? <GradeCard task={task} /> : null}
          {submission && !replacing ? <Receipt task={task} onReplace={() => setReplacing(true)} /> : null}
          {showSubmitPanel ? (
            <SubmitPanel
              key={`${task.id}-${submission?.revision || 0}-${replacing}`}
              task={task}
              now={now}
              replacing={replacing}
              onCancel={() => setReplacing(false)}
              onSubmitted={(next) => {
                setReplacing(false);
                onSubmitted?.(next);
              }}
            />
          ) : null}
          {!task.can_submit && !submission ? (
            <InlineNotification kind="info" lowContrast hideCloseButton className="rpt-banner" title="Submissions are closed." subtitle={task.lock_reason || "This report no longer accepts files."} />
          ) : null}

          <section className="rpt-card" aria-labelledby="rpt-brief-title">
            <h2 id="rpt-brief-title" className="rpt-card__title">
              Brief
            </h2>
            {task.brief ? <Markdown text={task.brief} /> : <p className="rpt-muted">No extra instructions for this target.</p>}
            {attachments.length ? (
              <>
                <h3 className="rpt-subtitle">Reference files</h3>
                <PreviewableFiles files={attachments} label="Reference files" />
              </>
            ) : null}
          </section>
        </div>

        <aside className="rpt-task__side" aria-label="Deadline and marking">
          <section className="rpt-card">
            <h2 className="rpt-card__title">Deadline</h2>
            <DeadlineFacts task={task} now={now} />
          </section>
          {task.criteria?.length && !task.grade ? (
            <section className="rpt-card">
              <h2 className="rpt-card__title">How it's marked</h2>
              <ul className="rpt-criteria">
                {task.criteria.map((criterion) => (
                  <li key={criterion.id}>
                    <span className="rpt-criteria__name">{criterion.name}</span>
                    <span className="rpt-criteria__max">{formatMarks(criterion.max_marks)}</span>
                    {criterion.description ? <span className="rpt-criteria__desc">{criterion.description}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </article>
  );
}

export default function ReportsTaskPage() {
  const { taskId } = useParams();
  const [state, setState] = useState({ task: null, loading: true, error: "", notFound: false });
  const now = useNow();

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    getReportTask(taskId)
      .then((response) => setState({ task: apiData(response, null), loading: false, error: "", notFound: false }))
      .catch((error) =>
        setState({
          task: null,
          loading: false,
          error: apiMessage(error, "Please try again."),
          notFound: error?.response?.status === 404,
        })
      );
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.loading && !state.task) return <PageSkeleton label="Loading report" count={2} />;
  if (state.notFound) {
    return (
      <EmptyState
        icon={Report}
        text="This report isn't available. It may not be open yet, or your course access has ended."
        action={
          <Button as={Link} to="/reports" kind="tertiary">
            All reports
          </Button>
        }
      />
    );
  }
  if (state.error && !state.task) {
    return <PageNotification kind="error" title="Couldn't load this report." subtitle={state.error} actionLabel="Try again" onAction={load} />;
  }
  return <ReportTaskView task={state.task} now={now} onSubmitted={(task) => setState((current) => ({ ...current, task }))} />;
}
