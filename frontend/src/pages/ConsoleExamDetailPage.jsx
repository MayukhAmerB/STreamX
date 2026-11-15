// Exam detail (UI overhaul plan §3.5, T3). OWNER: WS-D2. Mounted at
// /console/{teach,admin}/exams/:slug and the old /console/exams/:slug.
// Actions and readiness sit in the side column (under the title on phones);
// Publish stays disabled with its reason until the checklist passes; an
// unknown slug is a not-found page, never "Try again".
import "../features/exams/Exams.scss";

import { CheckmarkFilled, DocumentExport, Launch, MisuseOutline, Renew, Upload } from "@carbon/icons-react";
import { Button, Checkbox, TextInput } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ExamStateTag, useExamsBase } from "./ConsoleExamsPage";
import {
  ConfirmDialog,
  ErrorState,
  NotFoundState,
  PageHeader,
  PageNotification,
  PageSkeleton,
  StatChips,
  StatusTag,
  useToast,
} from "../features/app-shell/ui";
import useScrollCue from "../features/grading/useScrollCue";
import { gradingPaths, useWorkspaceRoot } from "../features/grading/workspaceRoot";
import {
  canClose,
  canEditSchedule,
  formatIstMoment,
  formatWindow,
  missingMaterials,
  PARTICIPATION_LABELS,
  publishAction,
  readinessSummary,
  scheduleFormFrom,
  schedulePayload,
  scheduleProblem,
  WINDOW_LABELS,
} from "../features/exams/examModel";
import {
  closeConsoleExam,
  examResultsCsvHref,
  getConsoleExam,
  getConsoleExamResults,
  listExamBatches,
  publishConsoleExam,
  unscheduleConsoleExam,
  updateConsoleExam,
  uploadExamMaterial,
} from "../features/exams/examsApi";
import { identityLine } from "../features/identity/identityModel";
import { apiData, apiMessage } from "../utils/api";

export function ReadinessChecklist({ readiness }) {
  if (!readiness) return null;
  const summary = readinessSummary(readiness);
  return (
    <section className="exm-section exm-card" aria-labelledby="exm-ready-title">
      <h2 id="exm-ready-title" className="exm-subtitle">
        Readiness: {summary.done} of {summary.total}
      </h2>
      <ul className="exm-checklist">
        {readiness.items.map((item) => (
          <li key={item.id}>
            {item.ok ? (
              <CheckmarkFilled size={16} className="exm-ok" aria-label="Done" />
            ) : (
              <MisuseOutline size={16} className="exm-bad" aria-label="Missing" />
            )}
            <span>
              <span className="exm-check-label">{item.label}</span>
              {item.detail ? <span className="exm-check-detail">{item.detail}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Publish (or Schedule) stays disabled, with the reason beside it, until the checklist passes. */
export function PublishBar({ exam, now = Date.now(), busy = "", onPublish, onUnschedule, onClose }) {
  const action = publishAction(exam, now);
  if (!exam?.can_manage) return null;
  return (
    <div className="exm-publish">
      <div className="exm-row">
        <Button kind="primary" disabled={action.disabled || Boolean(busy)} onClick={onPublish} aria-describedby="exm-publish-reason">
          {busy === "publish" ? "Working…" : action.label}
        </Button>
        {exam.state === "scheduled" ? (
          <Button kind="secondary" disabled={Boolean(busy)} onClick={onUnschedule}>
            Back to draft
          </Button>
        ) : null}
        {canClose(exam) ? (
          <Button kind="danger--tertiary" disabled={Boolean(busy)} onClick={onClose}>
            Close exam now
          </Button>
        ) : null}
      </div>
      <p id="exm-publish-reason" className="exm-reason">
        {action.reason}
      </p>
    </div>
  );
}

export function ScheduleForm({ exam, batches = [], form, problem = "", saving = false, onChange, onSave }) {
  if (!canEditSchedule(exam)) return null;
  const published = exam.state === "published";
  const set = (patch) => onChange?.({ ...form, ...patch });
  const toggleBatch = (id, checked) =>
    set({
      batchIds: checked ? [...new Set([...form.batchIds, id])] : form.batchIds.filter((item) => item !== id),
    });
  return (
    <section className="exm-section exm-card" aria-labelledby="exm-schedule-title">
      <h2 id="exm-schedule-title" className="exm-subtitle">
        Window and batches
      </h2>
      <div className="exm-form">
        <TextInput
          id="exm-opens"
          type="datetime-local"
          labelText="Opens (IST)"
          value={form.opensAt}
          disabled={published && exam.window !== "not_open"}
          onChange={(event) => set({ opensAt: event.target.value })}
        />
        <TextInput
          id="exm-closes"
          type="datetime-local"
          labelText="Closes (IST)"
          value={form.closesAt}
          onChange={(event) => set({ closesAt: event.target.value })}
        />
        <TextInput
          id="exm-limit"
          type="number"
          min={1}
          max={1440}
          labelText="Time limit (minutes, empty = until it closes)"
          value={form.timeLimit}
          onChange={(event) => set({ timeLimit: event.target.value })}
        />
      </div>
      <fieldset className="exm-batches">
        <legend className="exm-check-label">Batches that sit this exam</legend>
        {batches.map((batch) => (
          <Checkbox
            key={batch.id}
            id={`exm-batch-${batch.id}`}
            labelText={`${batch.title}${batch.batch ? ` (${batch.batch})` : ""} · ${batch.student_count} students`}
            checked={form.batchIds.includes(batch.id)}
            onChange={(_event, { checked }) => toggleBatch(batch.id, checked)}
          />
        ))}
      </fieldset>
      {problem ? (
        <p className="exm-reason" role="alert">
          {problem}
        </p>
      ) : null}
      <Button kind="secondary" disabled={saving || Boolean(problem)} onClick={onSave}>
        {saving ? "Saving…" : "Save window and batches"}
      </Button>
    </section>
  );
}

export function MaterialsPanel({ exam, busyPath = "", onUpload }) {
  const scrollRef = useScrollCue();
  const items = (exam?.questions || []).flatMap((question) =>
    (question.materials || []).map((item) => ({
      ...item,
      question: `Q${question.order}`,
    })),
  );
  if (!items.length) return null;
  const missing = missingMaterials(exam).length;
  return (
    <section className="exm-section" aria-labelledby="exm-materials-title">
      <h2 id="exm-materials-title" className="exm-subtitle">
        Evidence files ({items.length - missing} of {items.length} uploaded)
      </h2>
      <p className="exm-muted">Students get a short-lived private link to each file, only after they start the exam.</p>
      <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Evidence files" ref={scrollRef}>
        <table className="exm-table">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">File</th>
              <th scope="col">Status</th>
              {exam.can_manage ? <th scope="col">Upload</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.question}-${item.path}`}>
                <td>{item.question}</td>
                <td title={item.path}>{item.label || item.path.split("/").pop()}</td>
                <td>
                  <StatusTag status={item.uploaded ? "published" : "late"}>{item.uploaded ? "Uploaded" : "Missing"}</StatusTag>
                </td>
                {exam.can_manage ? (
                  <td>
                    <label className={`exm-upload-btn${busyPath === item.path ? " is-busy" : ""}`}>
                      <Upload size={16} aria-hidden="true" />
                      <span aria-hidden="true">{busyPath === item.path ? "Uploading…" : item.uploaded ? "Replace" : "Upload"}</span>
                      <input
                        type="file"
                        className="exm-visually-hidden"
                        aria-label={`Upload ${item.path.split("/").pop()}`}
                        disabled={busyPath === item.path}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) onUpload?.(item.path, file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const LEGACY_STUDENT_HREF = (id) => `/gradebook/students/${id}`;

export function ResultsPanel({ results, csvHref, studentHref = LEGACY_STUDENT_HREF }) {
  const scrollRef = useScrollCue();
  if (!results) return null;
  const { stats } = results;
  const chips = [
    { id: "participants", label: "Students", value: stats.participants },
    { id: "active", label: "In progress", value: stats.active },
    { id: "average", label: "Average", value: stats.average_score ?? "–" },
    { id: "top", label: "Top score", value: stats.top_score ?? "–" },
  ];
  return (
    <section className="exm-section" aria-labelledby="exm-results-title">
      <div className="exm-row exm-row--head">
        <h2 id="exm-results-title" className="exm-subtitle">
          Results (out of {results.exam.total_points})
        </h2>
        {csvHref ? (
          <Button kind="tertiary" size="sm" renderIcon={DocumentExport} href={csvHref}>
            Export CSV
          </Button>
        ) : null}
      </div>
      <StatChips items={chips} label="Exam summary" />
      {results.participants.length ? (
        <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Results (scrolls sideways)" ref={scrollRef}>
          <table className="exm-table">
            <thead>
              <tr>
                <th scope="col">Student (roll number · handle)</th>
                <th scope="col" className="exm-num">
                  #
                </th>
                <th scope="col">Batch</th>
                <th scope="col">Status</th>
                <th scope="col" className="exm-num">
                  Score
                </th>
                <th scope="col" className="exm-num">
                  Solved
                </th>
                <th scope="col" className="exm-num">
                  Wrong
                </th>
              </tr>
            </thead>
            <tbody>
              {results.participants.map((row) => (
                <tr key={row.student.id}>
                  <th scope="row">
                    <Link to={studentHref(row.student.id)}>{identityLine(row.identity, row.student)}</Link>
                  </th>
                  <td className="exm-num">{row.rank}</td>
                  <td>{row.batch?.title || "–"}</td>
                  <td>{PARTICIPATION_LABELS[row.status] || row.status}</td>
                  <td className="exm-num">{row.score}</td>
                  <td className="exm-num">{row.solved_count}</td>
                  <td className="exm-num">{row.wrong_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="exm-muted exm-after-chips">Nobody has started this exam yet.</p>
      )}
      {results.questions.length ? (
        <>
          <h3 className="exm-subtitle exm-section">Questions</h3>
          <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Question statistics">
            <table className="exm-table">
              <thead>
                <tr>
                  <th scope="col">Question</th>
                  <th scope="col" className="exm-num">
                    Solve rate
                  </th>
                  <th scope="col">Most common wrong answers</th>
                </tr>
              </thead>
              <tbody>
                {results.questions.map((question) => (
                  <tr key={question.key}>
                    <th scope="row">
                      Q{question.order}. {question.title}
                    </th>
                    <td className="exm-num">
                      {question.solve_rate === null ? "–" : `${question.solve_rate}%`} ({question.solved}/{question.attempted})
                    </td>
                    <td className="exm-wrong">
                      {question.wrong_answers.length
                        ? question.wrong_answers.map((item) => `${item.answer} ×${item.count}`).join(" · ")
                        : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

const WINDOW_STATUS = { open: "open", not_open: "scheduled", closed: "off" };

export default function ConsoleExamDetailPage() {
  const { slug } = useParams();
  const { showToast } = useToast();
  const base = useExamsBase();
  const paths = gradingPaths(useWorkspaceRoot());
  const [confirmClose, setConfirmClose] = useState(false);
  const [state, setState] = useState({
    exam: null,
    loading: true,
    error: "",
    missing: false,
  });
  const [results, setResults] = useState(null);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState(scheduleFormFrom(null));
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");

  const applyExam = useCallback((exam) => {
    setState({ exam, loading: false, error: "", missing: false });
    setForm(scheduleFormFrom(exam));
  }, []);

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    getConsoleExam(slug)
      .then((response) => {
        const exam = apiData(response, null);
        applyExam(exam);
        if (exam?.can_manage) {
          listExamBatches()
            .then((batchResponse) => setBatches(apiData(batchResponse, {})?.results || []))
            .catch(() => setBatches([]));
        }
      })
      .catch((error) =>
        setState({
          exam: null,
          loading: false,
          error: apiMessage(error, "Please try again."),
          missing: error?.response?.status === 404,
        }),
      );
    getConsoleExamResults(slug)
      .then((response) => setResults(apiData(response, null)))
      .catch(() => setResults(null));
  }, [slug, applyExam]);

  useEffect(load, [load]);

  const act = async (kind, request, success) => {
    setBusy(kind);
    setActionError("");
    try {
      const response = await request();
      const exam = apiData(response, null);
      if (exam?.slug) applyExam(exam);
      showToast({ kind: "success", title: response?.data?.message || success });
      getConsoleExamResults(slug)
        .then((resultsResponse) => setResults(apiData(resultsResponse, null)))
        .catch(() => {});
    } catch (error) {
      const reasons = error?.response?.data?.errors?.reasons;
      setActionError(Array.isArray(reasons) && reasons.length ? reasons.join(" ") : apiMessage(error, "Please try again."));
    } finally {
      setBusy("");
    }
  };

  const exam = state.exam;
  const problem = scheduleProblem(form);

  if (state.missing) {
    return (
      <NotFoundState
        title="This exam does not exist"
        body="It may have been removed, or the link has a typo."
        backHref={base}
        backLabel="Back to Exams"
      />
    );
  }

  return (
    <div className="exm-page">
      {state.loading && !exam ? <PageSkeleton label="Loading exam" count={3} /> : null}
      {!state.loading && state.error ? <ErrorState error={`Couldn't load this exam. ${state.error}`} onRetry={load} /> : null}
      {exam ? (
        <>
          <PageHeader
            eyebrow={null}
            breadcrumbs={[{ label: "Exams", href: base }]}
            title={exam.title}
            description={`${formatWindow(exam)} · ${exam.question_count} questions · ${exam.total_points} points`}
            actions={
              <div className="exm-row exm-head-actions">
                <span className="exm-row">
                  <ExamStateTag state={exam.state} />
                  <StatusTag status={WINDOW_STATUS[exam.window] || "scheduled"}>{WINDOW_LABELS[exam.window] || exam.window}</StatusTag>
                </span>
                <span className="exm-row exm-head-actions__buttons">
                  <Button
                    kind="ghost"
                    size="md"
                    hasIconOnly
                    renderIcon={Renew}
                    iconDescription="Refresh"
                    tooltipPosition="bottom"
                    onClick={load}
                  />
                  <Button kind="ghost" size="md" renderIcon={Launch} href={exam.labs_url} target="_blank" rel="noopener noreferrer">
                    Open labs
                  </Button>
                </span>
              </div>
            }
          />
          {actionError ? (
            <PageNotification kind="error" title="That didn't work." subtitle={actionError} onClose={() => setActionError("")} />
          ) : null}
          <div className="exm-detail">
            <aside className="exm-detail__aside" aria-label="Publishing">
              <PublishBar
                exam={exam}
                busy={busy}
                onPublish={() => act("publish", () => publishConsoleExam(slug), "Published.")}
                onUnschedule={() => act("unschedule", () => unscheduleConsoleExam(slug), "Back to draft.")}
                onClose={() => setConfirmClose(true)}
              />
              <ReadinessChecklist readiness={exam.readiness} />
              {exam.published_at || exam.closed_at ? (
                <p className="exm-muted">
                  {exam.published_at ? `Published ${formatIstMoment(exam.published_at)}. ` : ""}
                  {exam.closed_at ? `Closed ${formatIstMoment(exam.closed_at)}.` : ""}
                </p>
              ) : null}
            </aside>
            <div className="exm-detail__main">
              <ScheduleForm
                exam={exam}
                batches={batches}
                form={form}
                problem={problem}
                saving={busy === "save"}
                onChange={setForm}
                onSave={() => act("save", () => updateConsoleExam(slug, schedulePayload(form)), "Saved.")}
              />
              <MaterialsPanel
                exam={exam}
                busyPath={busy.startsWith("material:") ? busy.slice(9) : ""}
                onUpload={(path, file) =>
                  act(
                    `material:${path}`,
                    async () => {
                      await uploadExamMaterial(slug, path, file);
                      return getConsoleExam(slug);
                    },
                    "Evidence file uploaded.",
                  )
                }
              />
              <ResultsPanel results={results} csvHref={examResultsCsvHref(slug)} studentHref={paths.student} />
              {exam.can_manage ? (
                <p className="exm-muted exm-note">
                  <Upload size={16} aria-hidden="true" /> To change questions, import the exam file again on the{" "}
                  <Link to={base}>Exams page</Link>; the window and batches set here are kept.
                </p>
              ) : null}
            </div>
          </div>
          <ConfirmDialog
            open={confirmClose}
            danger
            title="Close this exam now?"
            objectName={exam.title}
            body="Students can no longer answer. Results stay as they are."
            confirmLabel="Close exam"
            onConfirm={() => {
              setConfirmClose(false);
              act("close", () => closeConsoleExam(slug), "Closed.");
            }}
            onCancel={() => setConfirmClose(false)}
          />
        </>
      ) : null}
    </div>
  );
}
