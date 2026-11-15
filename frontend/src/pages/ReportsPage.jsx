import "../features/reports/Reports.scss";

import { ArrowRight, ChartLine, ChevronRight, Report, Time } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton } from "../features/app-shell/ui";
import { listReportTasks } from "../features/reports/reportsApi";
import { formatIst, getCountdown, splitTasks } from "../features/reports/reportModel";
import StatusChip from "../features/reports/StatusChip";
import useNow from "../features/reports/useNow";
import { apiData, apiMessage } from "../utils/api";

export function taskPath(task) {
  return `/reports/tasks/${task.id}`;
}

export function taskMeta(task) {
  return [task.course?.title, task.week_number ? `Week ${task.week_number}` : "", task.section?.title]
    .filter(Boolean)
    .join(" · ");
}

/** Call to action for the hero card, by the student's status. */
export function heroAction(task) {
  if (task.status === "returned_for_revision") return "Fix and resubmit";
  if (task.status === "not_submitted") return task.can_submit ? "Submit report" : "View report";
  if (task.can_submit) return "View or replace";
  return "View report";
}

function Countdown({ task, now }) {
  const countdown = getCountdown(task.due_at, now);
  const lateWindow = task.window === "late";
  return (
    <span className={`rpt-countdown rpt-countdown--${lateWindow ? "urgent" : countdown.tone}`}>
      <Time size={16} aria-hidden="true" />
      <span>
        {lateWindow ? `Late window closes ${formatIst(task.late_until)}` : countdown.text}
      </span>
    </span>
  );
}

function TaskRow({ task }) {
  return (
    <li>
      <Link to={taskPath(task)} className="rpt-row">
        <span className="rpt-row__text">
          <span className="rpt-row__title">{task.title}</span>
          <span className="rpt-row__meta">
            {taskMeta(task)} · Due {formatIst(task.due_at)}
          </span>
        </span>
        <StatusChip item={task} size="sm" />
        <ChevronRight size={20} aria-hidden="true" className="rpt-row__chevron" />
      </Link>
    </li>
  );
}

/** Presentational view (also used by tests and the screenshot harness). */
export function ReportsListView({ tasks = [], loading = false, error = "", onRetry, now = Date.now() }) {
  const [courseId, setCourseId] = useState("all");
  const courses = useMemo(() => {
    const map = new Map();
    tasks.forEach((task) => task.course && map.set(String(task.course.id), task.course.title));
    return [...map.entries()];
  }, [tasks]);
  const visible = courseId === "all" ? tasks : tasks.filter((task) => String(task.course?.id) === courseId);
  const { current, open, past } = useMemo(() => splitTasks(visible), [visible]);

  return (
    <>
      <PageHeader
        title="Reports"
        description="One OSINT target a week. Upload your report before the deadline and see your marks here."
        actions={
          <Button as={Link} to="/reports/marks" kind="tertiary" renderIcon={ChartLine}>
            My marks
          </Button>
        }
      />
      {loading ? <PageSkeleton label="Loading reports" count={2} /> : null}
      {!loading && error ? (
        <PageNotification kind="error" title="Couldn't load your reports." subtitle={error} actionLabel={onRetry ? "Try again" : undefined} onAction={onRetry} />
      ) : null}
      {!loading && !error && tasks.length === 0 ? (
        <EmptyState icon={Report} text="No weekly reports yet. When your instructor publishes this week's target, it appears here." />
      ) : null}
      {!loading && !error && tasks.length > 0 ? (
        <div className="rpt-list-page">
          {courses.length > 1 ? (
            <div className="rpt-filters">
              <Select id="rpt-course-filter" labelText="Course" size="md" value={courseId} onChange={(event) => setCourseId(event.target.value)}>
                <SelectItem value="all" text="All courses" />
                {courses.map(([id, title]) => (
                  <SelectItem key={id} value={id} text={title} />
                ))}
              </Select>
            </div>
          ) : null}

          {current ? (
            <section className="rpt-hero" aria-labelledby="rpt-hero-title">
              <p className="rpt-eyebrow">{current.status === "returned_for_revision" ? "Needs your changes" : "This week's target"}</p>
              <h2 id="rpt-hero-title" className="rpt-hero__title">
                {current.title}
              </h2>
              <p className="rpt-hero__meta">{taskMeta(current)}</p>
              <div className="rpt-hero__facts">
                <Countdown task={current} now={now} />
                <StatusChip item={current} />
              </div>
              <p className="rpt-hero__due">Due {formatIst(current.due_at)}</p>
              <Button as={Link} to={taskPath(current)} kind="primary" renderIcon={ArrowRight} className="rpt-hero__cta">
                {heroAction(current)}
              </Button>
            </section>
          ) : (
            <section className="rpt-hero rpt-hero--quiet" aria-label="This week">
              <p className="rpt-eyebrow">This week</p>
              <p className="rpt-hero__meta">Nothing is due right now. Past reports and marks are below.</p>
            </section>
          )}

          {open.length ? (
            <section className="rpt-section" aria-labelledby="rpt-open-title">
              <h2 id="rpt-open-title" className="cds-section-title">
                Also open
              </h2>
              <ul className="rpt-rows">
                {open.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            </section>
          ) : null}

          {past.length ? (
            <section className="rpt-section" aria-labelledby="rpt-past-title">
              <h2 id="rpt-past-title" className="cds-section-title">
                Past weeks
              </h2>
              <ul className="rpt-rows">
                {past.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default function ReportsPage() {
  const [state, setState] = useState({ tasks: [], loading: true, error: "" });
  const now = useNow();

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    listReportTasks()
      .then((response) => setState({ tasks: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setState({ tasks: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return <ReportsListView tasks={state.tasks} loading={state.loading} error={state.error} onRetry={load} now={now} />;
}
