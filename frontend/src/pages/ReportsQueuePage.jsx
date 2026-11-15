import "../features/reports/Reports.scss";

import { ArrowLeft, ChevronLeft, ChevronRight, List, NextFilled, Report } from "@carbon/icons-react";
import { Button, InlineLoading, Search, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import FilePreview, { FileList } from "../features/reports/FilePreview";
import GradingForm from "../features/reports/GradingForm";
import { getSubmission, gradeSubmission, listManageTasks, listSubmissions } from "../features/reports/reportsApi";
import { formatIst, formatMinutesLate } from "../features/reports/reportModel";
import StatusChip, { LateChip } from "../features/reports/StatusChip";
import { apiData, apiMessage } from "../utils/api";
import { describeCounts } from "./ReportsGradingPage";

export const QUEUE_STATUS_OPTIONS = [
  { value: "awaiting", label: "Waiting to be marked" },
  { value: "", label: "All submissions" },
  { value: "under_review", label: "Draft marks (under review)" },
  { value: "graded", label: "Marked" },
  { value: "returned_for_revision", label: "Returned for revision" },
  { value: "resubmitted", label: "Resubmitted" },
];

/** Query params that define the queue (sent with every detail/grade call for neighbours). */
export function queueFilters(params) {
  const filters = {};
  ["task", "course", "status", "late", "q"].forEach((key) => {
    const value = params.get(key);
    if (value) filters[key] = value;
  });
  return filters;
}

const graderChipItem = (item) => ({
  status: item.status,
  final_marks: item.final_marks,
  max_marks: item.max_marks,
  marks_visible: true,
  is_late: item.is_late,
});

function isTyping(target) {
  const tag = String(target?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}

function QueueList({ items, onOpen }) {
  return (
    <ul className="rpt-rows" aria-label="Submissions">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="rpt-row" onClick={() => onOpen(item.id)}>
            <span className="rpt-row__text">
              <span className="rpt-row__title">{item.student.full_name || item.student.email}</span>
              <span className="rpt-row__meta">
                {item.task.title} · {formatIst(item.submitted_at)} · v{item.version_count}
                {item.is_late ? ` · ${formatMinutesLate(item.minutes_late)}` : ""}
              </span>
            </span>
            <StatusChip item={graderChipItem(item)} size="sm" />
            <ChevronRight size={20} aria-hidden="true" className="rpt-row__chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Split view: files on one side, marks on the other. Exported for the harness. */
export function GradingSplitView({ detail, saving, error, conflict, onSubmit, onReload, onNavigate, onBack }) {
  const [versionId, setVersionId] = useState(detail.current_version?.id || null);
  const [previewKey, setPreviewKey] = useState("");
  const [lastDetail, setLastDetail] = useState(detail.id);
  if (lastDetail !== detail.id) {
    setLastDetail(detail.id);
    setVersionId(detail.current_version?.id || null);
    setPreviewKey("");
  }
  const version = detail.versions.find((item) => item.id === versionId) || detail.current_version;
  const files = (version?.files || []).map((file) => ({ ...file, source: "submission" }));
  const firstPreviewable = files.find((file) => file.preview && file.preview !== "none");
  const selected = files.find((file) => `submission-${file.id}` === previewKey) || firstPreviewable || null;
  const { neighbours } = detail;

  return (
    <div className="rpt-split">
      <div className="rpt-split__bar">
        <div className="rpt-split__who">
          <h2 className="rpt-split__name">{detail.student.full_name || detail.student.email}</h2>
          <p className="rpt-muted">
            {detail.student.email} · {detail.task.title}
          </p>
          <div className="rpt-task__chips">
            <StatusChip item={graderChipItem({ ...detail, final_marks: detail.grade?.final_marks, max_marks: detail.task.max_marks })} size="sm" />
            {detail.is_late ? <LateChip minutesLate={formatMinutesLate(detail.minutes_late).replace(/ late$/, "")} /> : null}
          </div>
        </div>
        <div className="rpt-split__nav">
          {neighbours.position ? (
            <span className="rpt-muted">
              {neighbours.position} of {neighbours.total}
            </span>
          ) : null}
          <Button kind="ghost" size="sm" hasIconOnly renderIcon={ChevronLeft} iconDescription="Previous (K)" tooltipPosition="bottom" disabled={!neighbours.previous_id} onClick={() => onNavigate(neighbours.previous_id)} />
          <Button kind="ghost" size="sm" hasIconOnly renderIcon={ChevronRight} iconDescription="Next (J)" tooltipPosition="bottom" disabled={!neighbours.next_id} onClick={() => onNavigate(neighbours.next_id)} />
          <Button kind="tertiary" size="sm" renderIcon={NextFilled} disabled={!neighbours.next_ungraded_id} onClick={() => onNavigate(neighbours.next_ungraded_id)}>
            Next ungraded
          </Button>
          <Button kind="ghost" size="sm" renderIcon={List} onClick={onBack}>
            List
          </Button>
        </div>
      </div>
      <div className="rpt-split__panes">
        <section className="rpt-split__files" aria-label="Submitted files">
          {detail.versions.length > 1 ? (
            <Select id="rpt-version" labelText="Version" size="sm" value={String(version?.id || "")} onChange={(event) => { setVersionId(Number(event.target.value)); setPreviewKey(""); }}>
              {detail.versions.map((item) => (
                <SelectItem
                  key={item.id}
                  value={String(item.id)}
                  text={`v${item.number}${item.id === detail.current_version?.id ? " (latest)" : ""} · ${formatIst(item.submitted_at, { withWeekday: false })}${item.is_late ? " · late" : ""}${item.is_revision ? " · revision" : ""}`}
                />
              ))}
            </Select>
          ) : null}
          {version?.note ? <p className="rpt-receipt__note">“{version.note}”</p> : null}
          <FileList files={files} selectedKey={selected ? `submission-${selected.id}` : ""} onPreview={(file) => setPreviewKey(`submission-${file.id}`)} label="Files" />
          {selected ? <FilePreview file={selected} /> : <p className="rpt-preview__message">No preview for these files. Download them to review.</p>}
        </section>
        <section className="rpt-split__form" aria-label="Marks and feedback">
          <GradingForm
            key={`${detail.id}-${detail.revision}`}
            detail={detail}
            saving={saving}
            error={error}
            conflict={conflict}
            hasNext={Boolean(neighbours.next_ungraded_id)}
            onSubmit={onSubmit}
            onReload={onReload}
          />
          {detail.audit?.length ? (
            <details className="rpt-history">
              <summary>Marking history ({detail.audit.length})</summary>
              <ol className="rpt-history__list">
                {detail.audit.map((entry) => (
                  <li key={entry.id} className="rpt-history__meta">
                    {formatIst(entry.created_at)} · {entry.actor || "Someone"} · {entry.action_label}
                    {entry.old_final_marks !== entry.new_final_marks
                      ? ` · ${entry.old_final_marks ?? "–"} → ${entry.new_final_marks ?? "–"}`
                      : ""}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default function ReportsQueuePage() {
  const [params, setParams] = useSearchParams();
  const { showToast } = useToast();
  const filters = useMemo(() => queueFilters(params), [params]);
  const submissionId = params.get("submission");
  const [tasks, setTasks] = useState([]);
  const [queue, setQueue] = useState({ items: [], counts: null, loading: true, error: "" });
  const [detail, setDetail] = useState({ data: null, loading: false, error: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState(params.get("q") || "");
  const filterKey = JSON.stringify(filters);

  const updateParams = useCallback(
    (changes) => {
      const next = new URLSearchParams(params);
      Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
      setParams(next);
    },
    [params, setParams]
  );

  useEffect(() => {
    listManageTasks()
      .then((response) => setTasks((apiData(response, {})?.results || []).filter((task) => task.status !== "draft")))
      .catch(() => setTasks([]));
  }, []);

  const loadQueue = useCallback(() => {
    setQueue((current) => ({ ...current, loading: true, error: "" }));
    listSubmissions(JSON.parse(filterKey))
      .then((response) => {
        const data = apiData(response, {});
        setQueue({ items: data.results || [], counts: data.counts || null, loading: false, error: "" });
      })
      .catch((error) => setQueue({ items: [], counts: null, loading: false, error: apiMessage(error, "Please try again.") }));
  }, [filterKey]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const loadDetail = useCallback(() => {
    if (!submissionId) return;
    setDetail((current) => ({ ...current, loading: true, error: "" }));
    getSubmission(submissionId, JSON.parse(filterKey))
      .then((response) => {
        setDetail({ data: apiData(response, null), loading: false, error: "" });
        setConflict(false);
        setSaveError("");
      })
      .catch((error) => setDetail({ data: null, loading: false, error: apiMessage(error, "Please try again.") }));
  }, [submissionId, filterKey]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  const open = useCallback((id) => id && updateParams({ submission: String(id) }), [updateParams]);

  useEffect(() => {
    const neighbours = detail.data?.neighbours;
    if (!submissionId || !neighbours) return undefined;
    const onKey = (event) => {
      if (isTyping(event.target) && !event.altKey) return;
      const key = event.key.toLowerCase();
      if ((event.altKey && event.key === "ArrowRight") || (!event.altKey && key === "j")) open(neighbours.next_id);
      else if ((event.altKey && event.key === "ArrowLeft") || (!event.altKey && key === "k")) open(neighbours.previous_id);
      else if (!event.altKey && key === "u") open(neighbours.next_ungraded_id);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail.data, submissionId, open]);

  const submitGrade = (payload, { andNext }) => {
    setSaving(true);
    setSaveError("");
    setConflict(false);
    gradeSubmission(submissionId, payload, filters)
      .then((response) => {
        const data = apiData(response, null);
        showToast({ kind: "success", title: response?.data?.message || "Saved" });
        loadQueue();
        if (andNext && data?.neighbours?.next_ungraded_id) open(data.neighbours.next_ungraded_id);
        else setDetail({ data, loading: false, error: "" });
      })
      .catch((error) => {
        const code = error?.response?.data?.code || error?.response?.data?.errors?.code;
        if (error?.response?.status === 409 && code === "grade_conflict") setConflict(true);
        else setSaveError(apiMessage(error, "Not saved. Try again."));
      })
      .finally(() => setSaving(false));
  };

  const currentTask = tasks.find((task) => String(task.id) === filters.task);

  return (
    <div className="rpt-queue">
      <Link to={`/report-grading${currentTask ? `?course=${currentTask.course}` : ""}`} className="rpt-back">
        <ArrowLeft size={16} aria-hidden="true" /> Report grading
      </Link>
      <PageHeader
        title={currentTask ? currentTask.title : "Grading queue"}
        description={queue.counts ? describeCounts(queue.counts) : "Oldest submissions first."}
      />
      <div className="rpt-filters rpt-filters--queue">
        <Select id="rpt-queue-task" labelText="Weekly target" value={filters.task || ""} onChange={(event) => updateParams({ task: event.target.value, submission: "" })}>
          <SelectItem value="" text="All targets" />
          {tasks.map((task) => (
            <SelectItem key={task.id} value={String(task.id)} text={`${task.week_number ? `W${task.week_number} · ` : ""}${task.title}`} />
          ))}
        </Select>
        <Select id="rpt-queue-status" labelText="Status" value={filters.status || ""} onChange={(event) => updateParams({ status: event.target.value })}>
          {QUEUE_STATUS_OPTIONS.map((option) => (
            <SelectItem key={option.value || "all"} value={option.value} text={option.label} />
          ))}
        </Select>
        <Select id="rpt-queue-late" labelText="Timing" value={filters.late || ""} onChange={(event) => updateParams({ late: event.target.value })}>
          <SelectItem value="" text="On time and late" />
          <SelectItem value="1" text="Late only" />
          <SelectItem value="0" text="On time only" />
        </Select>
        <Search
          id="rpt-queue-search"
          labelText="Student"
          placeholder="Search students"
          size="lg"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") updateParams({ q: search.trim() });
          }}
          onClear={() => updateParams({ q: "" })}
        />
      </div>

      {submissionId ? (
        detail.loading && !detail.data ? (
          <PageSkeleton label="Loading submission" count={2} />
        ) : detail.error ? (
          <PageNotification kind="error" title="Couldn't open this submission." subtitle={detail.error} actionLabel="Try again" onAction={loadDetail} />
        ) : detail.data ? (
          <>
            {detail.loading ? <InlineLoading description="Loading…" /> : null}
            <GradingSplitView
              detail={detail.data}
              saving={saving}
              error={saveError}
              conflict={conflict}
              onSubmit={submitGrade}
              onReload={loadDetail}
              onNavigate={open}
              onBack={() => updateParams({ submission: "" })}
            />
          </>
        ) : null
      ) : (
        <>
          {queue.loading ? <PageSkeleton label="Loading submissions" count={2} /> : null}
          {!queue.loading && queue.error ? (
            <PageNotification kind="error" title="Couldn't load submissions." subtitle={queue.error} actionLabel="Try again" onAction={loadQueue} />
          ) : null}
          {!queue.loading && !queue.error && !queue.items.length ? (
            <EmptyState icon={Report} text={filters.status === "awaiting" ? "Nothing left to mark here. Nice work." : "No submissions match these filters."} />
          ) : null}
          {!queue.loading && queue.items.length ? (
            <>
              <div className="rpt-queue__start">
                <Button kind="primary" renderIcon={NextFilled} onClick={() => open((queue.items.find((item) => ["submitted", "resubmitted", "under_review"].includes(item.status)) || queue.items[0]).id)}>
                  Start marking
                </Button>
                <span className="rpt-muted">Shortcuts while marking: J next · K previous · U next ungraded · Ctrl + Enter save</span>
              </div>
              <QueueList items={queue.items} onOpen={open} />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
