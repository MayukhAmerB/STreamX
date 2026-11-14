// Exams (UI overhaul plan §3.5, T2 list). OWNER: WS-D2. Mounted at
// /console/{teach,admin}/exams and the old /console/exams. Staff import an
// exam JSON through a drop zone (server dry run first: counts only, the answer
// key never leaves the server); every disabled button says why.
import "../features/exams/Exams.scss";

import { DocumentImport, Flag, Upload } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DropZone, EmptyState, ErrorState, PageHeader, PageNotification, PageSkeleton, ResponsiveTable, StatusTag, T2List } from "../features/app-shell/ui";
import { formatWindow, previewLines, stateMeta, uploadProblems } from "../features/exams/examModel";
import { listConsoleExams, previewExamFile, uploadExamFile } from "../features/exams/examsApi";
import { useWorkspaceRoot } from "../features/grading/workspaceRoot";
import { apiData, apiMessage } from "../utils/api";

const EXAM_STATUS = { draft: "draft", scheduled: "scheduled", published: "published", closed: "off" };

/** StatusTag for an exam state (one vocabulary; "Closed" reads as Off-grey). */
export function ExamStateTag({ state }) {
  return <StatusTag status={EXAM_STATUS[state] || "draft"}>{stateMeta(state).label}</StatusTag>;
}

/** Where exam links point: the workspace tree, or the old /console/exams URL. */
export function useExamsBase() {
  const { pathname } = useLocation();
  const root = useWorkspaceRoot();
  return /^\/console\/(teach|admin)\//.test(pathname) ? `${root}/exams` : "/console/exams";
}

/** Why "Check file" / "Load exam" are disabled ("" when enabled). */
export function uploadReasons({ fileName, preview, problems = [], busy = "" }) {
  const checked = Boolean(preview && !problems.length);
  if (busy) return { check: "Working…", load: "Working…", checked };
  if (!fileName) return { check: "Choose a file first.", load: "Choose a file first.", checked };
  return { check: "", load: checked ? "" : "Check the file before loading it.", checked };
}

/**
 * Import an exam JSON: "Check file" runs the server dry run; "Load exam" is
 * enabled only after the same file passed the check.
 */
export function ExamUploadPanel({ fileName, preview, problems = [], error = "", busy = "", onPickFile, onCheck, onLoad }) {
  const reasons = uploadReasons({ fileName, preview, problems, busy });
  const reason = reasons.load || reasons.check;
  // The drop zone's <label> also holds a decorative "Choose a file" cue; name the
  // input exactly "Exam file" so it is found by that label (TODO(WS-A): keep
  // the cue outside the <label> and drop this).
  const controlsRef = useRef(null);
  useEffect(() => {
    controlsRef.current?.querySelector?.('input[type="file"]')?.setAttribute("aria-label", "Exam file");
  });
  return (
    <section className="exm-import" aria-labelledby="exm-upload-title">
      <div className="exm-import__text">
        <h2 id="exm-upload-title" className="exm-subtitle">
          Import an exam
        </h2>
        <p className="exm-muted">Check the JSON first: the server validates it and shows what would change, without saving anything.</p>
      </div>
      <div className="exm-import__controls" ref={controlsRef}>
        <DropZone accept="application/json,.json" label="Exam file" onFiles={(files) => onPickFile?.(files?.[0] || null)} />
        {fileName ? (
          <p className="exm-import__file">
            <span className="exm-muted">Chosen:</span> {fileName}
          </p>
        ) : null}
        <div className="exm-row">
          <Button kind="secondary" size="md" renderIcon={DocumentImport} disabled={Boolean(reasons.check)} aria-describedby="exm-upload-reason" onClick={onCheck}>
            {busy === "check" ? "Checking…" : "Check file"}
          </Button>
          <Button kind="primary" size="md" renderIcon={Upload} disabled={Boolean(reasons.load)} aria-describedby="exm-upload-reason" onClick={onLoad}>
            {busy === "load" ? "Loading…" : "Load exam"}
          </Button>
        </div>
        {reason && !busy ? (
          <p id="exm-upload-reason" className="exm-reason">
            {reason}
          </p>
        ) : null}
      </div>
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
      {reasons.checked ? (
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

export function examColumns() {
  return [
    { key: "title", header: "Exam", render: (exam) => exam.title },
    { key: "state", header: "State", render: (exam) => <ExamStateTag state={exam.state} /> },
    { key: "window", header: "Window (IST)", render: (exam) => <span className="exm-window">{formatWindow(exam)}</span> },
    { key: "batches", header: "Batches", render: (exam) => (exam.batches?.length ? exam.batches.map((batch) => batch.title).join(", ") : "None") },
    { key: "questions", header: "Questions", render: (exam) => <span className="exm-num-cell">{exam.question_count}</span> },
    { key: "ready", header: "Ready", render: (exam) => (exam.ready === null || exam.ready === undefined ? "–" : exam.ready ? "Yes" : "Not yet") },
    { key: "students", header: "Students", render: (exam) => <span className="exm-num-cell">{exam.stats?.participants ?? 0}</span> },
  ];
}

/** ResponsiveTable draws the sideways-scroll fade and turns rows into cards on phones. */
export function ExamListTable({ exams = [], basePath = "/console/exams" }) {
  return (
    <div className="exm-list">
      <ResponsiveTable columns={examColumns()} rows={exams.map((exam) => ({ ...exam, id: exam.slug }))} getRowHref={(exam) => `${basePath}/${exam.slug}`} />
    </div>
  );
}

export default function ConsoleExamsPage() {
  const navigate = useNavigate();
  const base = useExamsBase();
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
        navigate(`${base}/${data.report.slug}`);
        return;
      }
      setUpload({ preview: data.report, problems: [], error: "", busy: "" });
    } catch (error) {
      const problems = uploadProblems(error);
      setUpload({ preview: null, problems, error: problems.length ? "" : apiMessage(error, "Please try again."), busy: "" });
    }
  };

  let list;
  if (state.loading) list = <PageSkeleton label="Loading exams" count={2} />;
  else if (state.error) list = <ErrorState error={`Couldn't load exams. ${state.error}`} onRetry={load} />;
  else if (!state.exams.length) {
    list = (
      <EmptyState
        icon={Flag}
        title={state.canManage ? "No exams yet." : "No exam is assigned to your batches yet."}
        body={state.canManage ? "Import an exam file above to start." : "Exams appear here once staff assign one to a batch you teach."}
      />
    );
  } else list = <ExamListTable exams={state.exams} basePath={base} />;

  return (
    <div className="exm-page">
      <T2List
        header={
          <PageHeader
            eyebrow={null}
            title="Exams"
            description={state.canManage ? "Import OSINT CTF exams, choose batches, schedule them and follow the results." : "Exams for the batches you teach, and their results."}
          />
        }
        main={
          <>
            {state.canManage ? (
              <ExamUploadPanel fileName={file?.name || ""} {...upload} onPickFile={onPickFile} onCheck={() => run("check")} onLoad={() => run("load")} />
            ) : null}
            <section className="exm-section" aria-labelledby="exm-list-title">
              <h2 id="exm-list-title" className="exm-subtitle">
                {state.canManage ? "All exams" : "Exams for your batches"}
              </h2>
              {list}
            </section>
          </>
        }
      />
    </div>
  );
}
