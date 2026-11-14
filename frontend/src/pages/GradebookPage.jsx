import "../features/exams/Exams.scss";

import { ArrowLeft, DocumentExport, Table } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getUserRoles, ROLE_MODERATOR } from "../features/app-shell/navConfig";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, StatChips } from "../features/app-shell/ui";
import {
  batchGradebookCsvHref,
  getBatchGradebook,
  getMyGradebook,
  getStudentGradebook,
  listGradebookCourses,
} from "../features/gradebook/gradebookApi";
import { batchSummary, cellText, cellTone, columnLabel, formatPercent, sectionSummary } from "../features/gradebook/gradebookModel";
import { useAuth } from "../hooks/useAuth";
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
                <Link to={`/gradebook/students/${row.student.id}`}>{row.student.full_name || row.student.email}</Link>
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

export function StudentSections({ data }) {
  if (!data?.courses?.length) {
    return <EmptyState icon={Table} text="Marks appear here once a weekly report is graded or an exam closes." />;
  }
  return data.courses.map((section) => (
    <section key={section.course.id} className="exm-section" aria-labelledby={`gbk-course-${section.course.id}`}>
      <h2 id={`gbk-course-${section.course.id}`} className="exm-subtitle">
        {section.course.title}
      </h2>
      <StatChips items={sectionSummary(section.totals)} label={`${section.course.title} summary`} />
      {section.columns.length ? (
        <div className="exm-table-wrap" tabIndex={0} role="region" aria-label={`${section.course.title} marks`}>
          <table className="exm-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Type</th>
                <th scope="col" className="exm-num">
                  Mark
                </th>
              </tr>
            </thead>
            <tbody>
              {section.columns.map((column, index) => (
                <tr key={column.key}>
                  <th scope="row">{column.title}</th>
                  <td>{column.kind === "exam" ? "Exam" : "Weekly report"}</td>
                  <td className="exm-num">
                    <Cell cell={section.cells[index]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  ));
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
  const state = useLoad(getMyGradebook, []);
  return (
    <>
      <PageHeader title="Gradebook" description="Your weekly report marks and exam results in one place." />
      {state.loading ? <PageSkeleton label="Loading your marks" count={2} /> : null}
      {!state.loading && state.error ? <PageNotification kind="error" title="Couldn't load your marks." subtitle={state.error} /> : null}
      {!state.loading && state.data ? <StudentSections data={state.data} /> : null}
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
        title="Gradebook"
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
