import "../features/exams/Exams.scss";

import { DocumentImport, Flag, Upload } from "@carbon/icons-react";
import { Button, Tag } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton } from "../features/app-shell/ui";
import { formatWindow, previewLines, stateMeta, uploadProblems } from "../features/exams/examModel";
import { listConsoleExams, previewExamFile, uploadExamFile } from "../features/exams/examsApi";
import { apiData, apiMessage } from "../utils/api";

/**
 * Upload an exam JSON: "Check file" runs the server dry run (counts only,
 * the answer key never leaves the server); "Load exam" is enabled only after
 * the same file passed the check.
 */
export function ExamUploadPanel({ fileName, preview, problems = [], error = "", busy = "", onPickFile, onCheck, onLoad }) {
  const checked = Boolean(preview && !problems.length);
  return (
    <section className="exm-section exm-card" aria-labelledby="exm-upload-title">
      <h2 id="exm-upload-title" className="exm-subtitle">
        Upload an exam file
      </h2>
      <p className="exm-muted">
        Choose the exam JSON. Check it first: the server validates it and shows what would change, without saving anything.
      </p>
      <div className="exm-row exm-row--spaced">
        <label className="exm-file-input">
          <span className="exm-muted">Exam file (.json) </span>
          <input type="file" accept="application/json,.json" aria-label="Exam file" onChange={(event) => onPickFile?.(event.target.files?.[0] || null)} />
        </label>
        <Button kind="secondary" size="md" renderIcon={DocumentImport} disabled={!fileName || Boolean(busy)} onClick={onCheck}>
          {busy === "check" ? "Checking…" : "Check file"}
        </Button>
        <Button kind="primary" size="md" renderIcon={Upload} disabled={!checked || Boolean(busy)} onClick={onLoad}>
          {busy === "load" ? "Loading…" : "Load exam"}
        </Button>
      </div>
      {!checked && fileName && !busy ? <p className="exm-reason">Check the file before loading it.</p> : null}
      {error ? <PageNotification kind="error" title="The file could not be checked." subtitle={error} /> : null}
      {problems.length ? (
        <div className="exm-preview" role="alert">
          <p className="exm-check-label">Fix these problems in the file, then check it again:</p>
          <ul className="exm-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {checked ? (
        <div className="exm-preview" aria-live="polite">
          <p className="exm-check-label">Dry run passed. Nothing has been saved yet.</p>
          <ul>
            {previewLines(preview).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

export function ExamListTable({ exams = [] }) {
  return (
    <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Exams (scrolls sideways)">
      <table className="exm-table">
        <thead>
          <tr>
            <th scope="col">Exam</th>
            <th scope="col">State</th>
            <th scope="col">Window (IST)</th>
            <th scope="col">Batches</th>
            <th scope="col" className="exm-num">
              Questions
            </th>
            <th scope="col">Ready</th>
            <th scope="col" className="exm-num">
              Students
            </th>
          </tr>
        </thead>
        <tbody>
          {exams.map((exam) => {
            const meta = stateMeta(exam.state);
            return (
              <tr key={exam.slug}>
                <th scope="row">
                  <Link to={`/console/exams/${exam.slug}`}>{exam.title}</Link>
                </th>
                <td>
                  <Tag type={meta.tag} size="sm">
                    {meta.label}
                  </Tag>
                </td>
                <td>{formatWindow(exam)}</td>
                <td>{exam.batches.length ? exam.batches.map((batch) => batch.title).join(", ") : "None"}</td>
                <td className="exm-num">{exam.question_count}</td>
                <td>{exam.ready === null || exam.ready === undefined ? "–" : exam.ready ? "Yes" : "Not yet"}</td>
                <td className="exm-num">{exam.stats.participants}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ConsoleExamsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState({ exams: [], canManage: false, loading: true, error: "" });
  const [file, setFile] = useState(null);
  const [upload, setUpload] = useState({ preview: null, problems: [], error: "", busy: "" });

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    listConsoleExams()
      .then((response) => {
        const data = apiData(response, {});
        setState({ exams: data.results || [], canManage: Boolean(data.can_manage), loading: false, error: "" });
      })
      .catch((error) => setState({ exams: [], canManage: false, loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);

  useEffect(load, [load]);

  const onPickFile = (picked) => {
    setFile(picked);
    setUpload({ preview: null, problems: [], error: "", busy: "" });
  };

  const run = async (kind) => {
    if (!file) return;
    setUpload((current) => ({ ...current, busy: kind, error: "", problems: kind === "check" ? [] : current.problems }));
    try {
      const response = kind === "check" ? await previewExamFile(file) : await uploadExamFile(file);
      const data = apiData(response, {});
      if (kind === "load") {
        navigate(`/console/exams/${data.report.slug}`);
        return;
      }
      setUpload({ preview: data.report, problems: [], error: "", busy: "" });
    } catch (error) {
      const problems = uploadProblems(error);
      setUpload({ preview: null, problems, error: problems.length ? "" : apiMessage(error, "Please try again."), busy: "" });
    }
  };

  return (
    <>
      <PageHeader title="Exams" description="Load OSINT CTF exams, choose batches, schedule them and follow the results." />
      {state.canManage ? (
        <ExamUploadPanel
          fileName={file?.name || ""}
          {...upload}
          onPickFile={onPickFile}
          onCheck={() => run("check")}
          onLoad={() => run("load")}
        />
      ) : null}
      <section className="exm-section" aria-labelledby="exm-list-title">
        <h2 id="exm-list-title" className="exm-subtitle">
          {state.canManage ? "All exams" : "Exams for your batches"}
        </h2>
        {state.loading ? <PageSkeleton label="Loading exams" count={2} /> : null}
        {!state.loading && state.error ? (
          <PageNotification kind="error" title="Couldn't load exams." subtitle={state.error} actionLabel="Try again" onAction={load} />
        ) : null}
        {!state.loading && !state.error && !state.exams.length ? (
          <EmptyState icon={Flag} text={state.canManage ? "No exams yet. Upload an exam file to start." : "No exam is assigned to your batches yet."} />
        ) : null}
        {!state.loading && state.exams.length ? <ExamListTable exams={state.exams} /> : null}
      </section>
    </>
  );
}
