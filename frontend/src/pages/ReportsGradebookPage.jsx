import "../features/reports/Reports.scss";

import { ArrowLeft, DocumentExport, ErrorFilled, Table, WarningAltFilled } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, StatChips } from "../features/app-shell/ui";
import { getGradebook, listGradableCourses, marksExportHref } from "../features/reports/reportsApi";
import { formatMarks, STATUS_LABELS } from "../features/reports/reportModel";
import { apiData, apiMessage } from "../utils/api";

/** Class-level summary chips from the rows. */
export function classSummary(rows = []) {
  const withMarks = rows.filter((row) => row.totals.percentage !== null && row.totals.percentage !== undefined);
  const average = withMarks.length
    ? Math.round((withMarks.reduce((sum, row) => sum + Number(row.totals.percentage), 0) / withMarks.length) * 10) / 10
    : null;
  return [
    { id: "students", label: "Students", value: rows.length },
    { id: "average", label: "Class average", value: average === null ? "–" : `${average}%`, accent: true },
    { id: "missing", label: "Missing", value: rows.reduce((sum, row) => sum + row.totals.missing_count, 0) },
    { id: "late", label: "Late", value: rows.reduce((sum, row) => sum + row.totals.late_count, 0) },
  ];
}

function Cell({ cell }) {
  if (cell.final_marks !== null && cell.final_marks !== undefined) {
    return (
      <span className="rpt-gb__marks">
        {formatMarks(cell.final_marks)}
        {cell.is_late ? <WarningAltFilled size={16} aria-label="late" className="rpt-gb__late" /> : null}
      </span>
    );
  }
  if (cell.is_missing) {
    return (
      <span className="rpt-gb__missing">
        <ErrorFilled size={16} aria-hidden="true" /> Missing
      </span>
    );
  }
  if (!cell.submission_id) return <span className="rpt-muted">–</span>;
  return (
    <Link to={`/report-grading/queue?task=${cell.task_id}&submission=${cell.submission_id}`} className="rpt-gb__status">
      {STATUS_LABELS[cell.status] || cell.status}
      {cell.is_late ? <WarningAltFilled size={16} aria-label="late" className="rpt-gb__late" /> : null}
    </Link>
  );
}

export function GradebookTable({ book }) {
  return (
    <div className="rpt-table-wrap rpt-gb" tabIndex={0} role="region" aria-label="Gradebook (scrolls sideways)">
      <table className="rpt-table">
        <caption className="rpt-visually-hidden">Report marks for {book.course.title}</caption>
        <thead>
          <tr>
            <th scope="col" className="rpt-gb__student">
              Student
            </th>
            {book.tasks.map((task) => (
              <th key={task.id} scope="col" className="rpt-table__num" title={task.title}>
                <span className="rpt-gb__task">{task.week_number ? `W${task.week_number}` : task.title.slice(0, 12)}</span>
                <span className="rpt-gb__max">/{formatMarks(task.max_marks)}</span>
              </th>
            ))}
            <th scope="col" className="rpt-table__num">
              Total
            </th>
            <th scope="col" className="rpt-table__num">
              %
            </th>
            <th scope="col" className="rpt-table__num">
              Missing
            </th>
            <th scope="col" className="rpt-table__num">
              Late
            </th>
          </tr>
        </thead>
        <tbody>
          {book.rows.map((row) => {
            const totals = row.totals;
            return (
              <tr key={row.student.id}>
                <th scope="row" className="rpt-gb__student">
                  <span className="rpt-gb__name">{row.student.full_name || row.student.email}</span>
                  <span className="rpt-gb__email">{row.student.email}</span>
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.task_id} className="rpt-table__num">
                    <Cell cell={cell} />
                  </td>
                ))}
                <td className="rpt-table__num rpt-gb__total">
                  {formatMarks(totals.total_marks)}/{formatMarks(totals.max_marks)}
                </td>
                <td className="rpt-table__num">{totals.percentage === null ? "–" : `${formatMarks(totals.percentage)}%`}</td>
                <td className="rpt-table__num">{totals.missing_count}</td>
                <td className="rpt-table__num">{totals.late_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ReportsGradebookPage() {
  const [params, setParams] = useSearchParams();
  const [courses, setCourses] = useState([]);
  const [state, setState] = useState({ book: null, loading: true, error: "" });
  const courseId = params.get("course") || "";

  useEffect(() => {
    listGradableCourses()
      .then((response) => {
        const items = apiData(response, {})?.results || [];
        setCourses(items);
        if (!courseId && items[0]) setParams({ course: String(items[0].id) }, { replace: true });
        if (!items.length) setState({ book: null, loading: false, error: "" });
      })
      .catch((error) => setState({ book: null, loading: false, error: apiMessage(error, "Please try again.") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!courseId) return;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: "" }));
    getGradebook(courseId)
      .then((response) => !cancelled && setState({ book: apiData(response, null), loading: false, error: "" }))
      .catch((error) => !cancelled && setState({ book: null, loading: false, error: apiMessage(error, "Please try again.") }));
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const summary = useMemo(() => (state.book ? classSummary(state.book.rows) : []), [state.book]);

  return (
    <>
      <Link to={`/report-grading${courseId ? `?course=${courseId}` : ""}`} className="rpt-back">
        <ArrowLeft size={16} aria-hidden="true" /> Report grading
      </Link>
      <PageHeader
        title="Gradebook"
        description="Each student's marks per weekly report, with totals across marked reports."
        actions={
          courseId ? (
            <Button kind="tertiary" renderIcon={DocumentExport} href={marksExportHref({ course: courseId })}>
              Export CSV
            </Button>
          ) : null
        }
      />
      {courses.length > 1 ? (
        <div className="rpt-filters">
          <Select id="rpt-gb-course" labelText="Course" value={courseId} onChange={(event) => setParams({ course: event.target.value })}>
            {courses.map((course) => (
              <SelectItem key={course.id} value={String(course.id)} text={course.title} />
            ))}
          </Select>
        </div>
      ) : null}
      {state.loading ? <PageSkeleton label="Loading gradebook" count={2} /> : null}
      {!state.loading && state.error ? <PageNotification kind="error" title="Couldn't load the gradebook." subtitle={state.error} /> : null}
      {!state.loading && state.book && (!state.book.rows.length || !state.book.tasks.length) ? (
        <EmptyState icon={Table} text="The gradebook fills in once a weekly target is published and students are enrolled." />
      ) : null}
      {!state.loading && state.book?.rows.length && state.book.tasks.length ? (
        <>
          <StatChips items={summary} label="Class summary" />
          <GradebookTable book={state.book} />
          <p className="rpt-muted rpt-gb__legend">
            <WarningAltFilled size={16} aria-hidden="true" className="rpt-gb__late" /> late ·{" "}
            <ErrorFilled size={16} aria-hidden="true" /> missing (deadline passed, nothing submitted). Totals count marked reports only.
          </p>
        </>
      ) : null}
    </>
  );
}

