// Grading › Queue (UI overhaul plan §3.5, "Queue first"). OWNER: WS-D2.
// Moved from pages/ReportsQueuePage.jsx: the oldest work first, grouped by
// week then target, one "Start marking" action, and a split view (files on
// the left, marks on the right) with J / K / U keyboard navigation.
import "../reports/Reports.scss";
import "./Grading.scss";

import { ChevronLeft, ChevronRight, List, NextFilled, Report } from "@carbon/icons-react";
import { Button, InlineLoading, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, ErrorState, FeatureBoundary, PageSkeleton, useToast, Toolbar } from "../app-shell/ui";
import FilePreview, { FileList } from "../reports/FilePreview";
import GradingForm from "../reports/GradingForm";
import { getSubmission, gradeSubmission, listManageTasks, listSubmissions } from "../reports/reportsApi";
import { formatIst, formatMinutesLate } from "../reports/reportModel";
import StatusChip, { LateChip } from "../reports/StatusChip";
import { apiData, apiMessage } from "../../utils/api";
import { StudentIdentityHeader } from "../identity/StudentIdentityHeader";
import { identityLine } from "../identity/identityModel";
import { describeCounts } from "./GradingTasks";

/** Status chips of the queue. "To grade" is the default view (no `status` param). */
export const QUEUE_STATUS_OPTIONS = [
  { value: "awaiting", label: "To grade" },
  { value: "under_review", label: "Draft marks" },
  { value: "graded", label: "Marked" },
  { value: "returned_for_revision", label: "Returned" },
  { value: "resubmitted", label: "Resubmitted" },
  { value: "all", label: "All" },
];

const DEFAULT_STATUS = "awaiting";

/** Query params that define the queue (sent with every detail/grade call for neighbours). */
export function queueFilters(params) {
  const filters = {};
  ["task", "course", "late", "q", "week"].forEach((key) => {
    const value = params.get(key);
    if (value) filters[key] = value;
  });
  const status = params.get("status") || DEFAULT_STATUS;
  // "all" is not a server filter: the server lists every status without one.
  if (status !== "all") filters.status = status;
  // Grouped marking (week -> target -> oldest) is the default; group=off lists by age.
  if (params.get("group") !== "off") filters.group = "week";
  return filters;
}

/**
 * Groups queue items (already ordered week -> target -> oldest by the server)
 * into [{ key, label, targets: [{ key, name, items }] }].
 */
export function groupQueue(items = []) {
  const weeks = [];
  items.forEach((item) => {
    const weekKey = item.week_start || `task-${item.task.id}`;
    let week = weeks[weeks.length - 1];
    if (!week || week.key !== weekKey) {
      week = { key: weekKey, label: item.week_label || item.task.title, targets: [] };
      weeks.push(week);
    }
    const targetKey = item.target_key || item.target_name || item.task.title;
    let target = week.targets.find((entry) => entry.key === targetKey);
    if (!target) {
      target = { key: targetKey, name: item.target_name || item.task.title, items: [] };
      week.targets.push(target);
    }
    target.items.push(item);
  });
  return weeks;
}

/**
 * Keyboard map of the split view: J / Alt+→ next, K / Alt+← previous,
 * U next ungraded. Letters are ignored while typing in a field.
 * Returns the submission id to open, or null.
 */
export function queueKeyTarget(event, neighbours) {
  if (!neighbours || !event) return null;
  const typing = isTyping(event.target);
  if (typing && !event.altKey) return null;
  if (event.ctrlKey || event.metaKey) return null;
  const key = String(event.key || "").toLowerCase();
  if (event.altKey) {
    if (event.key === "ArrowRight") return neighbours.next_id || null;
    if (event.key === "ArrowLeft") return neighbours.previous_id || null;
    return null;
  }
  if (key === "j") return neighbours.next_id || null;
  if (key === "k") return neighbours.previous_id || null;
  if (key === "u") return neighbours.next_ungraded_id || null;
  return null;
}

/** Badges for duplicate signals: same target this week, identical file bytes. */
export function SignalBadges({ item }) {
  const badges = [];
  if (item.same_target_count) {
    badges.push(
      <span key="same" className="rpt-chip rpt-chip--info rpt-chip--sm" data-status="same-target">
        <span className="rpt-chip__label">Same target ×{item.same_target_count + 1}</span>
      </span>
    );
  }
  if (item.sha256_match_count) {
    badges.push(
      <span key="sha" className="rpt-chip rpt-chip--warning rpt-chip--sm" data-status="sha256" title="A submitted file has exactly the same bytes (SHA-256) as another student's file.">
        <span className="rpt-chip__label">Identical file ×{item.sha256_match_count}</span>
      </span>
    );
  }
  if (item.different_target_confirmed) {
    badges.push(
      <span key="confirmed" className="rpt-chip rpt-chip--neutral rpt-chip--sm" data-status="confirmed-different">
        <span className="rpt-chip__label">Student confirmed distinct target</span>
      </span>
    );
  }
  return badges.length ? <span className="rpt-task__chips">{badges}</span> : null;
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
  return tag === "input" || tag === "textarea" || tag === "select" || Boolean(target?.isContentEditable);
}

function QueueRows({ items, onOpen, showTarget = true }) {
  return (
    <ul className="grd-rows" aria-label="Submissions">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="grd-row" onClick={() => onOpen(item.id)}>
            <span className="grd-row__text">
              <span className="grd-row__title">{identityLine(item.identity, item.student)}</span>
              <span className="grd-row__meta">
                {showTarget ? `${item.target_name || item.task.title} · ` : ""}
                {formatIst(item.submitted_at)} · v{item.version_count}
                {item.is_late ? ` · ${formatMinutesLate(item.minutes_late)}` : ""}
              </span>
              <SignalBadges item={item} />
            </span>
            <StatusChip item={graderChipItem(item)} size="sm" />
            <ChevronRight size={16} aria-hidden="true" className="grd-row__chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function QueueList({ items, onOpen, grouped = false }) {
  if (!grouped) return <QueueRows items={items} onOpen={onOpen} />;
  return (
    <div className="grd-groups">
      {groupQueue(items).map((week) => (
        <section key={week.key} className="grd-group" aria-label={week.label}>
          <h2 className="grd-group__title">{week.label}</h2>
          {week.targets.map((target) => (
            <div key={target.key} className="grd-group__target">
              <h3 className="grd-group__target-title">
                {target.name} <span className="grd-muted">({target.items.length})</span>
              </h3>
              <QueueRows items={target.items} onOpen={onOpen} showTarget={false} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** Grader-only context: same target this week and identical files elsewhere. */
export function DuplicateSignals({ detail, onNavigate }) {
  const same = detail.same_target || [];
  const matches = detail.sha256_matches || [];
  if (!same.length && !matches.length && !detail.different_target_confirmed) return null;
  return (
    <details className="rpt-history" open={matches.length > 0}>
      <summary>Similar work ({same.length + matches.length})</summary>
      {detail.different_target_confirmed ? (
        <p className="rpt-muted">The student confirmed this is a different target from: {(detail.similar_targets || []).join(", ")}.</p>
      ) : null}
      {same.length ? (
        <>
          <p className="rpt-muted">Same target this week:</p>
          <ul className="rpt-history__list">
            {same.map((item) => (
              <li key={item.id}>
                <Button kind="ghost" size="sm" onClick={() => onNavigate(item.id)}>
                  {item.student.full_name || item.student.email}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {matches.length ? (
        <>
          <p className="rpt-muted">Identical files (same SHA-256):</p>
          <ul className="rpt-history__list">
            {matches.map((item) => (
              <li key={`${item.sha256}-${item.submission_id}`}>
                {item.file_name} = {item.student.full_name || item.student.email}
                {item.target_name ? ` (${item.target_name})` : ""} <code title={item.sha256}>{item.sha256.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}

/** Split view: files on one side, marks on the other. */
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
    <div className="grd-split">
      <div className="grd-split__bar">
        <Button kind="ghost" size="sm" renderIcon={List} onClick={onBack} className="grd-split__back">
          All submissions
        </Button>
        <div className="grd-split__who">
          <h2 className="grd-split__name">{identityLine(detail.identity, detail.student)}</h2>
          <p className="grd-muted">
            {detail.student.email} · {detail.target_name || detail.task.title}
            {detail.target_name && detail.target_name !== detail.task.title ? ` · ${detail.task.title}` : ""}
          </p>
          <div className="rpt-task__chips">
            <StatusChip item={graderChipItem({ ...detail, final_marks: detail.grade?.final_marks, max_marks: detail.task.max_marks })} size="sm" />
            {detail.is_late ? <LateChip minutesLate={formatMinutesLate(detail.minutes_late).replace(/ late$/, "")} /> : null}
          </div>
        </div>
        <div className="grd-split__nav">
          {neighbours.position ? (
            <span className="grd-muted grd-split__position">
              {neighbours.position} of {neighbours.total}
            </span>
          ) : null}
          <Button kind="ghost" size="sm" hasIconOnly renderIcon={ChevronLeft} iconDescription="Previous (K)" tooltipPosition="bottom" disabled={!neighbours.previous_id} onClick={() => onNavigate(neighbours.previous_id)} />
          <Button kind="ghost" size="sm" hasIconOnly renderIcon={ChevronRight} iconDescription="Next (J)" tooltipPosition="bottom" disabled={!neighbours.next_id} onClick={() => onNavigate(neighbours.next_id)} />
          <Button kind="tertiary" size="sm" renderIcon={NextFilled} disabled={!neighbours.next_ungraded_id} onClick={() => onNavigate(neighbours.next_ungraded_id)}>
            Next ungraded
          </Button>
        </div>
      </div>
      {/* Owner rule: roll number, real name, handle (at submission + most recent), stats, then the record. */}
      {detail.identity ? <StudentIdentityHeader identity={detail.identity} eyebrow="Student" compact /> : null}
      <div className="grd-split__panes">
        <section className="grd-split__files" aria-label="Submitted files">
          {detail.versions.length > 1 ? (
            <Select
              id="rpt-version"
              labelText="Version"
              size="sm"
              value={String(version?.id || "")}
              onChange={(event) => {
                setVersionId(Number(event.target.value));
                setPreviewKey("");
              }}
            >
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
        <section className="grd-split__form" aria-label="Marks and feedback">
          <FeatureBoundary key={`${detail.id}-${detail.revision}`} label="The marking form">
            <GradingForm
              detail={detail}
              saving={saving}
              error={error}
              conflict={conflict}
              hasNext={Boolean(neighbours.next_ungraded_id)}
              onSubmit={onSubmit}
              onReload={onReload}
            />
          </FeatureBoundary>
          <DuplicateSignals detail={detail} onNavigate={onNavigate} />
          {detail.audit?.length ? (
            <details className="rpt-history">
              <summary>Marking history ({detail.audit.length})</summary>
              <ol className="rpt-history__list">
                {detail.audit.map((entry) => (
                  <li key={entry.id} className="rpt-history__meta">
                    {formatIst(entry.created_at)} · {entry.actor || "Someone"} · {entry.action_label}
                    {entry.old_final_marks !== entry.new_final_marks ? ` · ${entry.old_final_marks ?? "–"} → ${entry.new_final_marks ?? "–"}` : ""}
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

function MoreFilters({ tasks, filters, params, onChange }) {
  const active = ["task", "late"].filter((key) => filters[key]).length + (params.get("group") === "off" ? 1 : 0);
  return (
    <details className="grd-more" open={active > 0 || undefined}>
      <summary>Task, order and timing{active ? ` (${active})` : ""}</summary>
      <div className="grd-more__fields">
        <Select id="rpt-queue-task" labelText="Task" size="md" value={filters.task || ""} onChange={(event) => onChange({ task: event.target.value, submission: "" })}>
          <SelectItem value="" text="All tasks" />
          {tasks.map((task) => (
            <SelectItem key={task.id} value={String(task.id)} text={`${task.week_number ? `W${task.week_number} · ` : ""}${task.title}`} />
          ))}
        </Select>
        <Select id="rpt-queue-group" labelText="Order" size="md" value={filters.group === "week" ? "week" : "off"} onChange={(event) => onChange({ group: event.target.value === "off" ? "off" : "" })}>
          <SelectItem value="week" text="By week, then target" />
          <SelectItem value="off" text="Oldest first" />
        </Select>
        <Select id="rpt-queue-late" labelText="Timing" size="md" value={filters.late || ""} onChange={(event) => onChange({ late: event.target.value })}>
          <SelectItem value="" text="On time and late" />
          <SelectItem value="1" text="Late only" />
          <SelectItem value="0" text="On time only" />
        </Select>
      </div>
    </details>
  );
}

/**
 * The queue body (rendered under the Grading tabs). `onCount` reports the
 * "to grade" count of the current filters so the tab can show it.
 */
export default function GradingQueue({ onCount }) {
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
  const status = params.get("status") || DEFAULT_STATUS;

  const updateParams = useCallback(
    (changes) => {
      const next = new URLSearchParams(params);
      Object.entries(changes).forEach(([key, value]) => (value ? next.set(key, value) : next.delete(key)));
      setParams(next);
    },
    [params, setParams]
  );

  useEffect(() => {
    listManageTasks(filters.course ? { course: filters.course } : {})
      .then((response) => setTasks((apiData(response, {})?.results || []).filter((task) => task.status !== "draft")))
      .catch(() => setTasks([]));
  }, [filters.course]);

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

  // Search applies itself after a short pause (no Enter needed, no request per key).
  const appliedSearch = params.get("q") || "";
  useEffect(() => {
    const value = search.trim();
    if (value === appliedSearch) return undefined;
    const timer = window.setTimeout(() => updateParams({ q: value }), 350);
    return () => window.clearTimeout(timer);
  }, [search, appliedSearch, updateParams]);

  // The tab badge counts what is waiting in the default view (all tasks, no search).
  const defaultView = status === DEFAULT_STATUS && !filters.task && !filters.q && !filters.late && !filters.week;
  useEffect(() => {
    if (defaultView && queue.counts && typeof onCount === "function") onCount(queue.counts.awaiting || 0);
  }, [defaultView, queue.counts, onCount]);

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
      const target = queueKeyTarget(event, neighbours);
      if (!target) return;
      event.preventDefault();
      open(target);
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

  if (submissionId) {
    if (detail.loading && !detail.data) return <PageSkeleton label="Loading submission" count={2} />;
    if (detail.error) return <ErrorState error={`Couldn't open this submission. ${detail.error}`} onRetry={loadDetail} />;
    if (!detail.data) return null;
    return (
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
    );
  }

  const firstToMark = queue.items.find((item) => ["submitted", "resubmitted", "under_review"].includes(item.status)) || queue.items[0];

  return (
    <div className="grd-queue">
      <Toolbar
        search={{
          value: search,
          placeholder: "Search students or targets",
          onChange: setSearch,
        }}
        chips={QUEUE_STATUS_OPTIONS.map((option) => ({
          key: option.value,
          label: option.label,
          active: status === option.value,
          count: option.value === status && queue.counts ? queue.counts.submitted : undefined,
          onClick: () => updateParams({ status: option.value === DEFAULT_STATUS ? "" : option.value, submission: "" }),
        }))}
      />
      <MoreFilters tasks={tasks} filters={filters} params={params} onChange={updateParams} />

      {queue.loading ? <PageSkeleton label="Loading submissions" count={2} /> : null}
      {!queue.loading && queue.error ? <ErrorState error={`Couldn't load submissions. ${queue.error}`} onRetry={loadQueue} /> : null}
      {!queue.loading && !queue.error && !queue.items.length ? (
        <EmptyState
          icon={Report}
          title={status === DEFAULT_STATUS ? "All caught up. Nothing is waiting to be marked." : "No submissions match these filters."}
          action={
            status === DEFAULT_STATUS ? null : (
              <Button kind="tertiary" size="md" onClick={() => updateParams({ status: "", q: "", task: "", late: "" })}>
                Show what needs marking
              </Button>
            )
          }
        />
      ) : null}
      {!queue.loading && queue.items.length ? (
        <>
          <div className="grd-queue__start">
            <Button kind="primary" className="sc-button--accent" renderIcon={NextFilled} onClick={() => open(firstToMark.id)}>
              Start marking
            </Button>
            <p className="grd-muted">{queue.counts ? describeCounts(queue.counts) : ""}</p>
          </div>
          <p className="grd-muted grd-queue__keys">
            While marking: <kbd>J</kbd> next · <kbd>K</kbd> previous · <kbd>U</kbd> next ungraded · <kbd>Ctrl</kbd> + <kbd>Enter</kbd> save
          </p>
          <QueueList items={queue.items} onOpen={open} grouped={filters.group === "week"} />
        </>
      ) : null}
    </div>
  );
}
