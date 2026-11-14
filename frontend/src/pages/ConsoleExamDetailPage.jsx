import "../features/exams/Exams.scss";

import { ArrowLeft, CheckmarkFilled, DocumentExport, Launch, MisuseOutline, Renew, Upload } from "@carbon/icons-react";
import { Button, Checkbox, Tag, TextInput } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader, PageNotification, PageSkeleton, StatChips, useToast } from "../features/app-shell/ui";
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
  stateMeta,
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
    set({ batchIds: checked ? [...new Set([...form.batchIds, id])] : form.batchIds.filter((item) => item !== id) });
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
      {problem ? <p className="exm-reason" role="alert">{problem}</p> : null}
      <Button kind="secondary" disabled={saving || Boolean(problem)} onClick={onSave}>
        {saving ? "Saving…" : "Save window and batches"}
      </Button>
    </section>
  );
}

export function MaterialsPanel({ exam, busyPath = "", onUpload }) {
  const items = (exam?.questions || []).flatMap((question) =>
    (question.materials || []).map((item) => ({ ...item, question: `Q${question.order}` }))
  );
  if (!items.length) return null;
  const missing = missingMaterials(exam).length;
  return (
    <section className="exm-section" aria-labelledby="exm-materials-title">
      <h2 id="exm-materials-title" className="exm-subtitle">
        Evidence files ({items.length - missing} of {items.length} uploaded)
      </h2>
      <p className="exm-muted">Students get a short-lived private link to each file, only after they start the exam.</p>
      <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Evidence files">
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
                <td>{item.uploaded ? "Uploaded" : "Missing"}</td>
                {exam.can_manage ? (
                  <td>
                    <label className="exm-file-input">
                      <input
                        type="file"
                        aria-label={`Upload ${item.path.split("/").pop()}`}
                        disabled={busyPath === item.path}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) onUpload?.(item.path, file);
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

export function ResultsPanel({ results, csvHref }) {
  if (!results) return null;
  const { stats } = results;
  const chips = [
    { id: "participants", label: "Students", value: stats.participants },
    { id: "active", label: "In progress", value: stats.active },
    { id: "average", label: "Average", value: stats.average_score ?? "–", accent: true },
    { id: "top", label: "Top score", value: stats.top_score ?? "–" },
  ];
  return (
    <section className="exm-section" aria-labelledby="exm-results-title">
      <div className="exm-row">
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
        <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Results (scrolls sideways)">
          <table className="exm-table">
            <thead>
              <tr>
                <th scope="col" className="exm-num">
                  #
                </th>
                <th scope="col">Student</th>
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
                  <td className="exm-num">{row.rank}</td>
                  <th scope="row">
                    <Link to={`/gradebook/students/${row.student.id}`}>{row.student.full_name || row.student.email}</Link>
                  </th>
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
        <p className="exm-muted">Nobody has started this exam yet.</p>
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

export default function ConsoleExamDetailPage() {
  const { slug } = useParams();
  const { showToast } = useToast();
  const [state, setState] = useState({ exam: null, loading: true, error: "" });
  const [results, setResults] = useState(null);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState(scheduleFormFrom(null));
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");

  const applyExam = useCallback((exam) => {
    setState({ exam, loading: false, error: "" });
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
      .catch((error) => setState({ exam: null, loading: false, error: apiMessage(error, "Please try again.") }));
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
  const meta = stateMeta(exam?.state);
  const problem = scheduleProblem(form);

  return (
    <>
      <Link to="/console/exams" className="exm-back">
        <ArrowLeft size={16} aria-hidden="true" /> Exams
      </Link>
      {state.loading && !exam ? <PageSkeleton label="Loading exam" count={3} /> : null}
      {!state.loading && state.error ? (
        <PageNotification kind="error" title="Couldn't load this exam." subtitle={state.error} actionLabel="Try again" onAction={load} />
      ) : null}
      {exam ? (
        <>
          <PageHeader
            title={exam.title}
            description={`${formatWindow(exam)} · ${exam.question_count} questions · ${exam.total_points} points`}
            actions={
              <div className="exm-row">
                <Tag type={meta.tag}>{meta.label}</Tag>
                <Tag type="outline">{WINDOW_LABELS[exam.window] || exam.window}</Tag>
                <Button kind="ghost" size="sm" renderIcon={Renew} onClick={load}>
                  Refresh
                </Button>
                <Button kind="ghost" size="sm" renderIcon={Launch} href={exam.labs_url} target="_blank" rel="noopener noreferrer">
                  Open labs
                </Button>
              </div>
            }
          />
          {actionError ? (
            <PageNotification kind="error" title="That didn't work." subtitle={actionError} onClose={() => setActionError("")} />
          ) : null}
          <PublishBar
            exam={exam}
            busy={busy}
            onPublish={() => act("publish", () => publishConsoleExam(slug), "Published.")}
            onUnschedule={() => act("unschedule", () => unscheduleConsoleExam(slug), "Back to draft.")}
            onClose={() => {
              if (typeof window !== "undefined" && window.confirm && !window.confirm("Close this exam now? Students can no longer answer.")) return;
              act("close", () => closeConsoleExam(slug), "Closed.");
            }}
          />
          <ReadinessChecklist readiness={exam.readiness} />
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
              act(`material:${path}`, async () => {
                await uploadExamMaterial(slug, path, file);
                return getConsoleExam(slug);
              }, "Evidence file uploaded.")
            }
          />
          {exam.published_at || exam.closed_at ? (
            <p className="exm-muted">
              {exam.published_at ? `Published ${formatIstMoment(exam.published_at)}. ` : ""}
              {exam.closed_at ? `Closed ${formatIstMoment(exam.closed_at)}.` : ""}
            </p>
          ) : null}
          <ResultsPanel results={results} csvHref={examResultsCsvHref(slug)} />
          {exam.can_manage ? (
            <p className="exm-muted">
              <Upload size={16} aria-hidden="true" /> To change questions, upload the exam file again on the Exams page; the window and batches set here are kept.
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
