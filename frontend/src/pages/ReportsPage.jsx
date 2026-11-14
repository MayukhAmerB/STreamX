import "../features/reports/Reports.scss";

import { ArrowRight, ChevronRight, Report, Time } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, FeatureBoundary, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import CourseworkHeader from "../features/coursework/CourseworkHeader";
import { getMyWeek, listReportTasks } from "../features/reports/reportsApi";
import WeeklyReportCard, { WeeklyReportView } from "../features/reports/WeeklyReportCard";
import { formatIst, getCountdown, splitTasks } from "../features/reports/reportModel";
import StatusChip from "../features/reports/StatusChip";
import useNow from "../features/reports/useNow";
import MyIdentityHeader from "../features/identity/StudentIdentityHeader";
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

/** Coursework hub header with the "This week" tab (plan §3.4). */
export function ReportsHeader() {
  return <CourseworkHeader active="week" />;
}

export function ReportsListView({ tasks = [], loading = false, error = "", onRetry, now = Date.now(), header = true, emptyText, emptyAction }) {
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
      {header ? <ReportsHeader /> : null}
      {loading ? <PageSkeleton label="Loading reports" count={2} /> : null}
      {!loading && error ? (
        <PageNotification kind="error" title="Couldn't load your reports." subtitle={error} actionLabel={onRetry ? "Try again" : undefined} onAction={onRetry} />
      ) : null}
      {!loading && !error && tasks.length === 0 ? (
        <EmptyState icon={Report} text={emptyText || "No weekly reports yet. When your instructor publishes this week's target, it appears here."} action={emptyAction} />
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

/**
 * Self-service courses first (one "Submit this week's report" card each), then
 * instructor-set weekly tasks (legacy flow). A course with reports off says so.
 */
export function WeeklySection({ courses = [], loading = false, error = "", onRetry, now, onChanged, notify }) {
  if (loading) return <PageSkeleton label="Loading this week" count={1} />;
  if (error) {
    return <PageNotification kind="error" title="Couldn't load this week's reports." subtitle={error} actionLabel={onRetry ? "Try again" : undefined} onAction={onRetry} />;
  }
  const enabled = courses.filter((course) => course.enabled);
  const off = courses.filter((course) => !course.enabled && !course.legacy_task_count);
  return (
    <div className="rpt-weekly-list">
      {enabled.map((course) => (
        <FeatureBoundary key={course.course.id} label={`The weekly report for ${course.course.title || "this course"}`}>
          <WeeklyReportCard state={course} now={now} onChanged={onChanged} notify={notify} />
        </FeatureBoundary>
      ))}
      {!enabled.length && off.length ? (
        <WeeklyReportView state={off[0]} now={now} />
      ) : null}
    </div>
  );
}

export default function ReportsPage() {
  const [state, setState] = useState({ tasks: [], loading: true, error: "" });
  const [week, setWeek] = useState({ courses: [], loading: true, error: "" });
  const { showToast } = useToast();
  const now = useNow();

  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    listReportTasks()
      .then((response) => setState({ tasks: apiData(response, {})?.results || [], loading: false, error: "" }))
      .catch((error) => setState({ tasks: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);

  const loadWeek = useCallback(({ quiet = false } = {}) => {
    if (!quiet) setWeek((current) => ({ ...current, loading: true, error: "" }));
    getMyWeek()
      .then((response) => setWeek({ courses: apiData(response, {})?.courses || [], loading: false, error: "" }))
      .catch((error) => setWeek({ courses: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);

  useEffect(() => {
    load();
    loadWeek();
  }, [load, loadWeek]);

  const hasSelfService = week.courses.some((course) => course.enabled);
  const hasLegacy = state.tasks.length > 0;

  return (
    <>
      <ReportsHeader />
      {/* Owner rule: roll number, real name, handle, stats lead the submission screen. */}
      <div className="rpt-identity">
        <MyIdentityHeader />
      </div>
      <WeeklySection
        courses={week.courses}
        loading={week.loading}
        error={week.error}
        onRetry={() => loadWeek()}
        now={now}
        onChanged={() => loadWeek({ quiet: true })}
        notify={showToast}
      />
      {state.loading || state.error || hasLegacy || (!hasSelfService && !week.courses.length) ? (
        <ReportsListView
          header={false}
          tasks={state.tasks}
          loading={state.loading}
          error={state.error}
          onRetry={load}
          now={now}
          emptyText={week.courses.length || week.loading ? "No instructor-set weekly tasks right now." : "Weekly reports start once you join a course."}
          emptyAction={
            week.courses.length || week.loading ? undefined : (
              <Button as={Link} to="/courses" kind="tertiary" renderIcon={ArrowRight}>
                Browse courses
              </Button>
            )
          }
        />
      ) : null}
    </>
  );
}
