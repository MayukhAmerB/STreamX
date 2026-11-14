import "../features/exams/Exams.scss";
import "../features/coursework/Coursework.scss";

import { ArrowLeft, ArrowRight, DocumentExport, Table } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getUserRoles, ROLE_MODERATOR } from "../features/app-shell/navConfig";
import { EmptyState, ErrorState, PageHeader, PageNotification, PageSkeleton, StatChips, StatusTag } from "../features/app-shell/ui";
import CourseworkHeader from "../features/coursework/CourseworkHeader";
import { BarList, StatTile } from "../site-kit/data";
import {
  batchGradebookCsvHref,
  getBatchGradebook,
  getMyGradebook,
  getStudentGradebook,
  listGradebookCourses,
} from "../features/gradebook/gradebookApi";
import { batchSummary, cellText, cellTone, columnLabel, formatPercent } from "../features/gradebook/gradebookModel";
import { useAuth } from "../hooks/useAuth";
import { identityLine } from "../features/identity/identityModel";
import { apiData, apiMessage } from "../utils/api";

function Cell({ cell }) {
  const tone = cellTone(cell);
  return <span className={tone ? `gbk-cell--${tone}` : undefined}>{cellText(cell)}</span>;
}

function ColumnHeader({ column }) {
  const label = columnLabel(column);
  return (
    <th scope="col" className="exm-num" title={label.full}>
      <span className="gbk-kind">{label.kind}</span>
      {label.title}
    </th>
  );
}

export function BatchGradebookTable({ book }) {
  return (
    <div className="exm-table-wrap" tabIndex={0} role="region" aria-label="Gradebook (scrolls sideways)">
      <table className="exm-table">
        <caption className="exm-muted">Reports and exams for {book.course.title}</caption>
        <thead>
          <tr>
            <th scope="col">Student</th>
            {book.columns.map((column) => (
              <ColumnHeader key={column.key} column={column} />
            ))}
            <th scope="col" className="exm-num">
              Reports
            </th>
            <th scope="col" className="exm-num">
              Exams
            </th>
            <th scope="col" className="exm-num">
              Overall
            </th>
          </tr>
        </thead>
        <tbody>
          {book.rows.map((row) => (
            <tr key={row.student.id}>
              <th scope="row">
                <Link to={`/gradebook/students/${row.student.id}`}>{identityLine(row.identity, row.student)}</Link>
              </th>
              {row.cells.map((cell) => (
                <td key={cell.key} className="exm-num">
                  <Cell cell={cell} />
                </td>
              ))}
              <td className="exm-num">{formatPercent(row.totals.reports.percentage)}</td>
              <td className="exm-num">{formatPercent(row.totals.exams.percentage)}</td>
              <td className="exm-num">{formatPercent(row.totals.overall_percentage)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function percentValue(value) {
  return value === null || value === undefined ? null : Number(value);
}

/** Report marks per week as bars (percent), when there are at least two. */
function reportBars(section) {
  const bars = [];
  section.columns.forEach((column, index) => {
    const cell = section.cells[index];
    if (column.kind === "exam" || !cell || cell.value === null || cell.value === undefined || !Number(column.max)) return;
    bars.push({ label: column.short_title || column.title, value: Math.round((Number(cell.value) / Number(column.max)) * 100) });
  });
  if (bars.length) bars[bars.length - 1].highlight = true;
  return bars.length >= 2 ? bars : [];
}

/** A student's marks per course: three numbers, the trend, then every item. */
export function StudentSections({ data, emptyAction }) {
  if (!data?.courses?.length) {
    return <EmptyState icon={Table} text="Marks appear here once a weekly report is graded or an exam closes." action={emptyAction} />;
  }
  return data.courses.map((section) => {
    const bars = reportBars(section);
    const tiles = [
      { id: "reports", label: "Reports", value: percentValue(section.totals?.reports?.percentage) },
      { id: "exams", label: "Exams", value: percentValue(section.totals?.exams?.percentage) },
      { id: "overall", label: "Overall", value: percentValue(section.totals?.overall_percentage) },
    ];
    return (
      <section key={section.course.id} className="cw-course" aria-labelledby={`gbk-course-${section.course.id}`}>
        <h2 id={`gbk-course-${section.course.id}`} className="cw-course__title">
          {section.course.title}
        </h2>
        <div className="cw-tiles" role="group" aria-label={`${section.course.title} summary`}>
          {tiles.map((tile) => (
            <StatTile
              key={tile.id}
              label={tile.label}
              value={tile.value === null ? "–" : tile.value}
              format={(value) => formatPercent(value)}
              sessionKey={`grades-${section.course.id}-${tile.id}`}
            />
          ))}
        </div>
        {bars.length ? <BarList data={bars} caption="Report score per week (%)" max={100} format={(value) => `${value}%`} /> : null}
        {section.columns.length ? (
          <div className="cw-table-wrap" tabIndex={0} role="region" aria-label={`${section.course.title} marks`}>
            <table className="cw-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col" className="cw-type">
                    Type
                  </th>
                  <th scope="col" className="cw-num">
                    Mark
                  </th>
                </tr>
              </thead>
              <tbody>
                {section.columns.map((column, index) => {
                  const cell = section.cells[index];
                  return (
                    <tr key={column.key}>
                      <th scope="row">{column.title}</th>
                      <td className="cw-type">{column.kind === "exam" ? "Exam" : "Weekly report"}</td>
                      <td className="cw-num">
                        <Cell cell={cell} />
                        {cell?.is_late ? <StatusTag status="late" /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    );
  });
}

function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: "" });
  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: "" }));
    loader()
      .then((response) => !cancelled && setState({ data: apiData(response, null), loading: false, error: "" }))
      .catch((error) => !cancelled && setState({ data: null, loading: false, error: apiMessage(error, "Please try again.") }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function MyGradebook() {
  const [attempt, setAttempt] = useState(0);
  const state = useLoad(getMyGradebook, [attempt]);
  return (
    <>
      <CourseworkHeader active="grades" />
      <div className="cw-page">
        {state.loading ? <PageSkeleton label="Loading your marks" count={2} /> : null}
        {!state.loading && state.error ? <ErrorState error={state.error} onRetry={() => setAttempt((value) => value + 1)} /> : null}
        {!state.loading && state.data ? (
          <StudentSections
            data={state.data}
            emptyAction={
              <Button as={Link} to="/reports" kind="tertiary" renderIcon={ArrowRight}>
                Go to this week
              </Button>
            }
          />
        ) : null}
      </div>
    </>
  );
}

function BatchGradebook() {
  const [params, setParams] = useSearchParams();
  const [courses, setCourses] = useState({ items: [], error: "" });
  const courseId = params.get("course") || "";

  useEffect(() => {
    listGradebookCourses()
      .then((response) => {
        const items = apiData(response, {})?.results || [];
        setCourses({ items, error: "" });
        if (!courseId && items[0]) setParams({ course: String(items[0].id) }, { replace: true });
      })
      .catch((error) => setCourses({ items: [], error: apiMessage(error, "Please try again.") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = useLoad(() => (courseId ? getBatchGradebook(courseId) : Promise.resolve(null)), [courseId]);
  const summary = useMemo(() => (state.data?.rows ? batchSummary(state.data.rows) : []), [state.data]);
  const book = state.data;

  return (
    <>
      <PageHeader
        title="Marks"
        description="Weekly reports and CTF exams together, per batch. Read only."
        actions={
          courseId ? (
            <Button kind="tertiary" renderIcon={DocumentExport} href={batchGradebookCsvHref(courseId)}>
              Export CSV
            </Button>
          ) : null
        }
      />
      {courses.error ? <PageNotification kind="error" title="Couldn't load your batches." subtitle={courses.error} /> : null}
      {courses.items.length > 1 ? (
        <Select id="gbk-course" labelText="Batch" value={courseId} onChange={(event) => setParams({ course: event.target.value })}>
          {courses.items.map((course) => (
            <SelectItem key={course.id} value={String(course.id)} text={course.batch ? `${course.title} (${course.batch})` : course.title} />
          ))}
        </Select>
      ) : null}
      {courseId && state.loading ? <PageSkeleton label="Loading gradebook" count={2} /> : null}
      {!state.loading && state.error ? <PageNotification kind="error" title="Couldn't load the gradebook." subtitle={state.error} /> : null}
      {!state.loading && book && (!book.rows.length || !book.columns.length) ? (
        <EmptyState icon={Table} text="The gradebook fills in once a weekly report is published or an exam is set for this batch." />
      ) : null}
      {!state.loading && book?.rows?.length && book.columns.length ? (
        <>
          <div className="exm-section">
            <StatChips items={summary} label="Batch summary" />
          </div>
          <BatchGradebookTable book={book} />
          <p className="exm-muted exm-section">
            Report marks and exam points use different scales, so each has its own percentage; Overall is their average.
          </p>
        </>
      ) : null}
    </>
  );
}

export function StudentGradebookPage() {
  const { studentId } = useParams();
  const state = useLoad(() => getStudentGradebook(studentId), [studentId]);
  return (
    <>
      <Link to="/gradebook" className="exm-back">
        <ArrowLeft size={16} aria-hidden="true" /> Gradebook
      </Link>
      <PageHeader
        title={state.data?.student?.full_name || state.data?.student?.email || "Student"}
        description="Every weekly report and exam for this student, per batch."
      />
      {state.loading ? <PageSkeleton label="Loading marks" count={2} /> : null}
      {!state.loading && state.error ? <PageNotification kind="error" title="Couldn't load this student." subtitle={state.error} /> : null}
      {!state.loading && state.data ? <StudentSections data={state.data} /> : null}
    </>
  );
}

/** Students see their own marks; instructors and admins see their batches. */
export default function GradebookPage() {
  const auth = useAuth();
  const isModerator = getUserRoles(auth).has(ROLE_MODERATOR);
  return isModerator ? <BatchGradebook /> : <MyGradebook />;
}
