import "../features/reports/Reports.scss";

import {
  Add,
  Copy,
  Download,
  Edit,
  Locked,
  Report,
  Send,
  Table,
  Unlocked,
  View,
  WarningAltFilled,
  CheckmarkOutline,
  DocumentExport,
} from "@carbon/icons-react";
import { Button, InlineNotification, Modal, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import {
  closeTask,
  duplicateTask,
  listGradableCourses,
  listManageTasks,
  marksExportHref,
  publishTask,
  releaseMarks,
  reopenTask,
  taskZipHref,
} from "../features/reports/reportsApi";
import { formatIst, formatMarks } from "../features/reports/reportModel";
import { apiData, apiMessage } from "../utils/api";

const TASK_STATUS = {
  draft: { label: "Draft", icon: Edit, tone: "neutral" },
  published: { label: "Published", icon: CheckmarkOutline, tone: "accent" },
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

/** "12/30 submitted · 5 to mark · 2 late" */
export function describeCounts(counts = {}) {
  const parts = [`${counts.submitted || 0}/${counts.students || 0} submitted`];
  if (counts.awaiting) parts.push(`${counts.awaiting} to mark`);
  if (counts.graded) parts.push(`${counts.graded} marked`);
  if (counts.returned) parts.push(`${counts.returned} returned`);
  if (counts.late) parts.push(`${counts.late} late`);
  return parts.join(" · ");
}

function TaskCard({ task, onAction, busy }) {
  const awaiting = task.counts?.awaiting || 0;
  const canRelease = task.marks_visibility === "on_release" && !task.marks_released_at && task.status !== "draft";
  return (
    <li className="rpt-card rpt-manage-task">
      <div className="rpt-manage-task__head">
        <div className="rpt-manage-task__text">
          <p className="rpt-eyebrow">
            {task.week_number ? `Week ${task.week_number}` : "Weekly target"}
            {task.section_title ? ` · ${task.section_title}` : ""}
          </p>
          <h3 className="rpt-manage-task__title">{task.title}</h3>
          <p className="rpt-muted">
            Due {formatIst(task.due_at)} · out of {formatMarks(task.max_marks)}
            {task.criteria?.length ? ` · ${task.criteria.length}-part rubric` : ""}
          </p>
        </div>
        <TaskStatusTag status={task.status} />
      </div>
      {task.status !== "draft" ? <p className="rpt-manage-task__counts">{describeCounts(task.counts)}</p> : null}
      {canRelease && task.counts?.graded ? (
        <p className="rpt-manage-task__hold">
          <WarningAltFilled size={16} aria-hidden="true" /> Marks are held until you release them.
        </p>
      ) : null}
      <div className="rpt-manage-task__actions">
        {task.status !== "draft" ? (
          <Button
            as={Link}
            to={`/report-grading/queue?task=${task.id}${awaiting ? "&status=awaiting" : ""}`}
            kind={awaiting ? "primary" : "tertiary"}
            size="sm"
            renderIcon={View}
          >
            {awaiting ? `Mark ${awaiting}` : "Submissions"}
          </Button>
        ) : (
          <Button kind="primary" size="sm" renderIcon={Send} disabled={busy} onClick={() => onAction("publish", task)}>
            Publish
          </Button>
        )}
        <Button as={Link} to={`/report-grading/tasks/${task.id}/edit`} kind="ghost" size="sm" renderIcon={Edit}>
          Edit
        </Button>
        <Button kind="ghost" size="sm" renderIcon={Copy} disabled={busy} onClick={() => onAction("duplicate", task)}>
          Duplicate as next week
        </Button>
        {canRelease ? (
          <Button kind="ghost" size="sm" renderIcon={Unlocked} disabled={busy} onClick={() => onAction("release", task)}>
            Release marks
          </Button>
        ) : null}
        {task.status === "published" ? (
          <Button kind="ghost" size="sm" renderIcon={Locked} disabled={busy} onClick={() => onAction("close", task)}>
            Close
          </Button>
        ) : null}
        {task.status === "closed" ? (
          <Button kind="ghost" size="sm" renderIcon={Unlocked} disabled={busy} onClick={() => onAction("reopen", task)}>
            Reopen
          </Button>
        ) : null}
        {task.counts?.submitted ? (
          <>
            <Button kind="ghost" size="sm" renderIcon={Download} href={taskZipHref(task.id)}>
              All files (.zip)
            </Button>
            <Button kind="ghost" size="sm" renderIcon={DocumentExport} href={marksExportHref({ task: task.id })}>
              Marks (.csv)
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

const CONFIRMATIONS = {
  publish: (task) => ({
    title: `Publish “${task.title}”?`,
    body: `Students in the course are notified now, and reminded 24 hours before the deadline (${formatIst(task.due_at)}).`,
    primary: "Publish",
  }),
  close: (task) => ({
    title: `Close “${task.title}”?`,
    body: "No more files are accepted, even inside the late window. You can reopen it later.",
    primary: "Close submissions",
    danger: true,
  }),
  release: (task) => ({
    title: "Release marks to students?",
    body: `Everyone marked for “${task.title}” sees their marks and feedback and gets a notification. This can't be undone.`,
    primary: "Release marks",
  }),
};

export default function ReportsGradingPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [courses, setCourses] = useState({ items: [], loading: true, error: "" });
  const [tasks, setTasks] = useState({ items: [], loading: true, error: "" });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [actionError, setActionError] = useState("");
  const courseId = params.get("course") || "";

  useEffect(() => {
    listGradableCourses()
      .then((response) => setCourses({ items: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setCourses({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);

  const activeCourse = useMemo(
    () => courses.items.find((course) => String(course.id) === courseId) || courses.items[0] || null,
    [courses.items, courseId]
  );

  const loadTasks = useCallback(() => {
    if (!activeCourse) return;
    setTasks((current) => ({ ...current, loading: true, error: "" }));
    listManageTasks({ course: activeCourse.id })
      .then((response) => setTasks({ items: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setTasks({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, [activeCourse]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  const run = async (action, task) => {
    setBusy(true);
    setActionError("");
    try {
      if (action === "duplicate") {
        const response = await duplicateTask(task.id);
        const copy = apiData(response, {});
        showToast({ kind: "success", title: "Next week's draft is ready", subtitle: "Check the dates, then publish." });
        navigate(`/report-grading/tasks/${copy.id}/edit`);
        return;
      }
      const calls = { publish: publishTask, close: closeTask, reopen: reopenTask, release: releaseMarks };
      const response = await calls[action](task.id);
      showToast({ kind: "success", title: response?.data?.message || "Saved" });
      loadTasks();
    } catch (error) {
      setActionError(apiMessage(error, "That didn't work. Try again."));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const onAction = (action, task) => {
    if (CONFIRMATIONS[action]) setConfirm({ action, task, ...CONFIRMATIONS[action](task) });
    else run(action, task);
  };

  const header = (
    <PageHeader
      title="Report grading"
      description="Set weekly targets, mark submissions and export marks."
      actions={
        activeCourse ? (
          <>
            <Button as={Link} to={`/report-grading/gradebook?course=${activeCourse.id}`} kind="tertiary" renderIcon={Table}>
              Gradebook
            </Button>
            <Button as={Link} to={`/report-grading/tasks/new?course=${activeCourse.id}`} kind="primary" renderIcon={Add}>
              New weekly target
            </Button>
          </>
        ) : null
      }
    />
  );

  if (courses.loading) return <>{header}<PageSkeleton label="Loading your courses" count={2} /></>;
  if (courses.error) {
    return (
      <>
        {header}
        <PageNotification kind="error" title="Couldn't load your courses." subtitle={courses.error} />
      </>
    );
  }
  if (!courses.items.length) {
    return (
      <>
        {header}
        <EmptyState icon={Report} text="You don't teach any courses yet, so there is nothing to mark." />
      </>
    );
  }

  return (
    <>
      {header}
      <div className="rpt-filters">
        <Select
          id="rpt-grading-course"
          labelText="Course"
          value={String(activeCourse?.id || "")}
          onChange={(event) => setParams({ course: event.target.value })}
        >
          {courses.items.map((course) => (
            <SelectItem key={course.id} value={String(course.id)} text={course.title} />
          ))}
        </Select>
      </div>
      {actionError ? (
        <InlineNotification kind="error" lowContrast className="rpt-banner" title="Not saved." subtitle={actionError} onClose={() => setActionError("")} />
      ) : null}
      {tasks.loading ? <PageSkeleton label="Loading weekly targets" count={2} /> : null}
      {!tasks.loading && tasks.error ? (
        <PageNotification kind="error" title="Couldn't load weekly targets." subtitle={tasks.error} actionLabel="Try again" onAction={loadTasks} />
      ) : null}
      {!tasks.loading && !tasks.error && !tasks.items.length ? (
        <EmptyState
          icon={Report}
          text="No weekly targets for this course yet."
          action={
            <Button as={Link} to={`/report-grading/tasks/new?course=${activeCourse.id}`} renderIcon={Add}>
              New weekly target
            </Button>
          }
        />
      ) : null}
      {!tasks.loading && tasks.items.length ? (
        <ul className="rpt-manage-list" aria-label="Weekly targets">
          {tasks.items.map((task) => (
            <TaskCard key={task.id} task={task} onAction={onAction} busy={busy} />
          ))}
        </ul>
      ) : null}
      <Modal
        open={Boolean(confirm)}
        modalHeading={confirm?.title || ""}
        primaryButtonText={busy ? "Working…" : confirm?.primary || "Confirm"}
        secondaryButtonText="Cancel"
        danger={Boolean(confirm?.danger)}
        primaryButtonDisabled={busy}
        onRequestSubmit={() => confirm && run(confirm.action, confirm.task)}
        onRequestClose={() => !busy && setConfirm(null)}
        size="sm"
      >
        <p>{confirm?.body}</p>
      </Modal>
    </>
  );
}
