import "../features/reports/Reports.scss";

import { ArrowLeft, ChartLine } from "@carbon/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, StatChips } from "../features/app-shell/ui";
import MarksTrendChart from "../features/reports/MarksTrendChart";
import { getMyMarks } from "../features/reports/reportsApi";
import { formatIst, formatMarks, getTrendPoints, summarizeMarks } from "../features/reports/reportModel";
import StatusChip from "../features/reports/StatusChip";
import { apiData, apiMessage } from "../utils/api";

/** Stat chips for one course's totals. */
export function marksStatItems(totals) {
  return [
    {
      id: "total",
      label: "Total",
      value: totals.graded ? totals.total : "–",
      suffix: totals.graded ? `/${totals.outOf}` : "",
      accent: true,
    },
    { id: "percent", label: "Score", value: totals.percentage === null ? "–" : `${formatMarks(totals.percentage)}%` },
    { id: "graded", label: "Graded", value: totals.graded },
    { id: "missing", label: "Missing", value: totals.missing },
    { id: "late", label: "Late", value: totals.late },
  ];
}

function CourseMarks({ entry }) {
  const totals = summarizeMarks(entry.cells);
  const points = getTrendPoints(entry.tasks, entry.cells);
  const cells = new Map(entry.cells.map((cell) => [cell.task_id, cell]));
  return (
    <section className="rpt-section rpt-course-marks" aria-labelledby={`rpt-course-${entry.course.id}`}>
      <h2 id={`rpt-course-${entry.course.id}`} className="rpt-course-marks__title">
        {entry.course.title}
      </h2>
      <StatChips items={marksStatItems(totals)} label={`${entry.course.title} totals`} />
      <MarksTrendChart points={points} title="Score per week" />
      <ul className="rpt-rows" aria-label="Reports in this course">
        {[...entry.tasks]
          .sort((a, b) => new Date(b.due_at) - new Date(a.due_at))
          .map((task) => {
            const cell = cells.get(task.id) || {};
            return (
              <li key={task.id}>
                <Link to={`/reports/tasks/${task.id}`} className="rpt-row">
                  <span className="rpt-row__text">
                    <span className="rpt-row__title">{task.title}</span>
                    <span className="rpt-row__meta">
                      {task.week_number ? `Week ${task.week_number} · ` : ""}Due {formatIst(task.due_at)}
                    </span>
                  </span>
                  <StatusChip
                    size="sm"
                    item={{
                      status: cell.status,
                      final_marks: cell.final_marks,
                      max_marks: cell.max_marks,
                      marks_visible: cell.final_marks !== null && cell.final_marks !== undefined,
                      is_late: cell.is_late,
                    }}
                  />
                </Link>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

export function MyMarksView({ courses = [], loading = false, error = "", onRetry }) {
  return (
    <>
      <Link to="/reports" className="rpt-back">
        <ArrowLeft size={16} aria-hidden="true" /> All reports
      </Link>
      <PageHeader title="My marks" description="Your weekly report marks per course. Totals count only reports that have been marked." />
      {loading ? <PageSkeleton label="Loading marks" count={2} /> : null}
      {!loading && error ? (
        <PageNotification kind="error" title="Couldn't load your marks." subtitle={error} actionLabel={onRetry ? "Try again" : undefined} onAction={onRetry} />
      ) : null}
      {!loading && !error && courses.length === 0 ? (
        <EmptyState icon={ChartLine} text="No marks yet. Once your weekly reports are marked, your totals appear here." />
      ) : null}
      {!loading && !error ? courses.map((entry) => <CourseMarks key={entry.course.id} entry={entry} />) : null}
    </>
  );
}

export default function ReportsMarksPage() {
  const [state, setState] = useState({ courses: [], loading: true, error: "" });
  const load = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    getMyMarks()
      .then((response) => setState({ courses: apiData(response, {})?.courses || [], loading: false, error: "" }))
      .catch((error) => setState({ courses: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return <MyMarksView courses={state.courses} loading={state.loading} error={state.error} onRetry={load} />;
}
