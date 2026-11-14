// Grading › Tasks (UI overhaul plan §3.5). OWNER: WS-D2. Moved from
// pages/ReportsGradingPage.jsx: one row per weekly task with ONE primary
// action ("Mark n" or "Publish"); the rest are quiet. Course policy fields
// moved to the Settings tab.
import "../reports/Reports.scss";
import "./Grading.scss";

import { Add, CheckmarkOutline, Edit, Locked, OverflowMenuVertical, Report, Send, View, WarningAltFilled } from "@carbon/icons-react";
import { Button, OverflowMenu, OverflowMenuItem } from "@carbon/react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton, useToast } from "../app-shell/ui";
import { closeTask, duplicateTask, listManageTasks, marksExportHref, publishTask, releaseMarks, reopenTask, taskZipHref } from "../reports/reportsApi";
import { formatIst, formatMarks } from "../reports/reportModel";
import { apiData, apiMessage } from "../../utils/api";

const TASK_STATUS = {
  draft: { label: "Draft", icon: Edit, tone: "neutral" },
  published: { label: "Published", icon: CheckmarkOutline, tone: "success" },
  closed: { label: "Closed", icon: Locked, tone: "neutral" },
};

export function TaskStatusTag({ status }) {
  const meta = TASK_STATUS[status] || TASK_STATUS.draft;
  const Icon = meta.icon;
  return (
    <span className={`rpt-chip rpt-chip--${meta.tone} rpt-chip--sm`} data-status={status}>
      <Icon size={16} aria-hidden="true" className="rpt-chip__icon" />
      <span className="rpt-chip__label">{meta.label}</span>
    </span>
  );
}

/** "12/30 submitted · 5 to mark · 2 late" (or "12 submitted · …" without a class size). */
export function describeCounts(counts = {}) {
  const submitted = counts.submitted || 0;
  const parts = [counts.students ? `${submitted}/${counts.students} submitted` : `${submitted} submitted`];
  if (counts.awaiting) parts.push(`${counts.awaiting} to mark`);
  if (counts.graded) parts.push(`${counts.graded} marked`);
  if (counts.returned) parts.push(`${counts.returned} returned`);
  if (counts.late) parts.push(`${counts.late} late`);
  return parts.join(" · ");
}

export const TASK_CONFIRMATIONS = {
  publish: (task) => ({
    title: "Publish this task?",
    body: `Students in the course are notified now, and reminded 24 hours before the deadline (${formatIst(task.due_at)}).`,
    confirmLabel: "Publish",
  }),
  close: () => ({
    title: "Close submissions?",
    body: "No more files are accepted, even inside the late window. You can reopen it later.",
    confirmLabel: "Close submissions",
    danger: true,
  }),
  release: () => ({
    title: "Release marks to students?",
    body: "Everyone marked for this task sees their marks and feedback and gets a notification. This can't be undone.",
    confirmLabel: "Release marks",
  }),
};

/** The one action a task row leads with. */
export function primaryTaskAction(task) {
  const awaiting = task.counts?.awaiting || 0;
  if (task.status === "draft") return { kind: "publish", label: "Publish" };
  if (awaiting) return { kind: "mark", label: `Mark ${awaiting}` };
  return { kind: "submissions", label: "Submissions" };
}

export function TaskRow({ task, paths, busy, onAction }) {
  const primary = primaryTaskAction(task);
  const canRelease = task.marks_visibility === "on_release" && !task.marks_released_at && task.status !== "draft";
  const queueHref = paths.queue({ task: task.id, course: task.course, status: primary.kind === "mark" ? "" : "all" });
  return (
    <li className="grd-task">
      <div className="grd-task__text">
        <p className="grd-task__eyebrow">
          {task.week_number ? `Week ${task.week_number}` : "Weekly task"}
          {task.section_title ? ` · ${task.section_title}` : ""}
        </p>
        <h3 className="grd-task__title">
          <Link to={paths.editTask(task.id)}>{task.title}</Link>
        </h3>
        <p className="grd-muted">
          Due {formatIst(task.due_at)} · out of {formatMarks(task.max_marks)}
          {task.criteria?.length ? ` · ${task.criteria.length}-part rubric` : ""}
        </p>
        {task.status !== "draft" ? <p className="grd-task__counts">{describeCounts(task.counts)}</p> : null}
        {canRelease && task.counts?.graded ? (
          <p className="grd-task__hold">
            <WarningAltFilled size={16} aria-hidden="true" /> Marks are held until you release them.
          </p>
        ) : null}
      </div>
      <div className="grd-task__side">
        <TaskStatusTag status={task.status} />
        <div className="grd-task__actions">
          {primary.kind === "publish" ? (
            <Button kind="tertiary" size="sm" renderIcon={Send} disabled={busy} onClick={() => onAction("publish", task)}>
              Publish
            </Button>
          ) : (
            <Button as={Link} to={queueHref} kind={primary.kind === "mark" ? "secondary" : "ghost"} size="sm" renderIcon={View}>
              {primary.label}
            </Button>
          )}
          <OverflowMenu
            aria-label={`More actions for ${task.title}`}
            iconDescription={`More actions for ${task.title}`}
            renderIcon={OverflowMenuVertical}
            flipped
            size="sm"
          >
            <OverflowMenuItem itemText="Edit" onClick={() => onAction("edit", task)} />
            <OverflowMenuItem itemText="Duplicate as next week" disabled={busy} onClick={() => onAction("duplicate", task)} />
            {canRelease ? <OverflowMenuItem itemText="Release marks" disabled={busy} onClick={() => onAction("release", task)} /> : null}
            {task.status === "closed" ? <OverflowMenuItem itemText="Reopen" disabled={busy} onClick={() => onAction("reopen", task)} /> : null}
            {task.counts?.submitted ? <OverflowMenuItem itemText="Download all files (.zip)" href={taskZipHref(task.id)} /> : null}
            {task.counts?.submitted ? <OverflowMenuItem itemText="Export marks (.csv)" href={marksExportHref({ task: task.id })} /> : null}
            {task.status === "published" ? <OverflowMenuItem itemText="Close submissions" isDelete hasDivider disabled={busy} onClick={() => onAction("close", task)} /> : null}
          </OverflowMenu>
        </div>
      </div>
    </li>
  );
}

/** The task list of one course. */
export default function GradingTasks({ course, paths }) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [tasks, setTasks] = useState({ items: [], loading: true, error: "" });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);

  const load = useCallback(() => {
    if (!course) return;
    setTasks((current) => ({ ...current, loading: true, error: "" }));
    listManageTasks({ course: course.id })
      .then((response) => setTasks({ items: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setTasks({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, [course]);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (action, task) => {
    setBusy(true);
    try {
      if (action === "duplicate") {
        const copy = apiData(await duplicateTask(task.id), {});
        showToast({ kind: "success", title: "Next week's draft is ready", subtitle: "Check the dates, then publish." });
        navigate(paths.editTask(copy.id));
        return;
      }
      const calls = { publish: publishTask, close: closeTask, reopen: reopenTask, release: releaseMarks };
      const response = await calls[action](task.id);
      showToast({ kind: "success", title: response?.data?.message || "Saved" });
      load();
    } catch (error) {
      showToast({ kind: "error", title: "That didn't work.", subtitle: apiMessage(error, "Try again.") });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const onAction = (action, task) => {
    if (action === "edit") navigate(paths.editTask(task.id));
    else if (TASK_CONFIRMATIONS[action]) setConfirm({ action, task, ...TASK_CONFIRMATIONS[action](task) });
    else run(action, task);
  };

  if (!course) return null;
  if (tasks.loading) return <PageSkeleton label="Loading tasks" count={2} />;
  if (tasks.error) return <ErrorState error={`Couldn't load tasks. ${tasks.error}`} onRetry={load} />;
  if (!tasks.items.length) {
    return (
      <EmptyState
        icon={Report}
        title="No weekly tasks for this course yet."
        body="Students on self-service reports name their own targets; add a task when everyone should investigate the same one."
        action={
          <Button as={Link} to={paths.newTask({ course: course.id })} kind="tertiary" renderIcon={Add}>
            New task
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ul className="grd-tasks" aria-label="Weekly tasks">
        {tasks.items.map((task) => (
          <TaskRow key={task.id} task={task} paths={paths} busy={busy} onAction={onAction} />
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title || ""}
        objectName={confirm?.task?.title}
        body={confirm?.body}
        confirmLabel={busy ? "Working…" : confirm?.confirmLabel || "Confirm"}
        danger={Boolean(confirm?.danger)}
        onConfirm={() => confirm && run(confirm.action, confirm.task)}
        onCancel={() => !busy && setConfirm(null)}
      />
    </>
  );
}
