// Student Console page "Attendance". OWNER: WS-ATTENDANCE.
// Summary (attended X of Y, %, streak), per-batch breakdown and every class
// with its status, minutes present and the recording link. Mobile first.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../kit/Button";
import { Card } from "../../kit/Card";
import { Field, Select } from "../../kit/Form";
import { Play } from "../../kit/icons";

import { errorMessage, fetchMyClasses, fetchMySummary, isAttendanceDisabledError } from "./attendanceApi";
import {
  STATUS_FILTERS,
  formatDate,
  formatMinutes,
  formatPercent,
  ruleLabel,
  streakLabel,
  summaryLine,
} from "./attendanceModel";
import { AttendanceStatus, InlineError, Loading, OffState, PageIntro, PercentBar, StatTile } from "./AttendanceParts";

const PAGE_SIZE = 20;

export function SummaryView({ summary }) {
  if (!summary) return null;
  const rule = summary.rule || {};
  return (
    <section aria-labelledby="att-summary" className="flex flex-col gap-4">
      <h2 id="att-summary" className="sr-only">
        Summary
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Attended" value={`${summary.attended} / ${summary.total}`} hint={summaryLine(summary)} />
        <StatTile label="Attendance" value={formatPercent(summary.percent)} hint={summary.low_attendance ? `Below ${rule.low_attendance_percent || 75}%` : "Live classes only"} emphasis={summary.low_attendance} />
        <StatTile label="Current streak" value={summary.streak?.current ?? 0} hint={streakLabel(summary.streak)} />
        <StatTile label="Best streak" value={summary.streak?.best ?? 0} hint={`${summary.excused || 0} excused`} />
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-white/70">
        <AttendanceStatus status="present" label={ruleLabel(rule)} />
        <span>{rule.explanation}</span>
      </p>
      {summary.low_attendance ? (
        <Card tone="surface" className="border-accent/40 p-4 text-sm leading-6 text-white/80" role="status">
          Your attendance is below {rule.low_attendance_percent || 75}%. Join the next live classes to bring it back up.
        </Card>
      ) : null}
    </section>
  );
}

export function CourseBreakdown({ courses = [] }) {
  if (!courses.length) return null;
  return (
    <section aria-labelledby="att-courses" className="flex flex-col gap-3">
      <h2 id="att-courses" className="text-base font-semibold text-white">
        By batch
      </h2>
      <ul className="grid gap-3 md:grid-cols-2">
        {courses.map((item) => (
          <li key={item.course?.id ?? "other"}>
            <Card tone="surface" className="flex flex-col gap-2 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-medium text-white">
                  {item.course?.title}
                  {item.course?.batch ? <span className="text-white/55"> · {item.course.batch}</span> : null}
                </span>
                <span className="shrink-0 tabular-nums text-white">{formatPercent(item.percent)}</span>
              </div>
              <PercentBar percent={item.percent} label={`${item.course?.title}: ${formatPercent(item.percent)} attended`} />
              <span className="text-xs text-white/55">
                {item.attended} of {item.total} attended · {item.partial} partial · {item.absent} absent
                {item.excused ? ` · ${item.excused} excused` : ""}
              </span>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ClassList({ rows = [] }) {
  if (!rows.length) {
    return <p className="text-sm text-white/55">No finished live classes yet. They appear here after each class ends.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-white/55">
              <time dateTime={row.starts_at || row.date}>{formatDate(row.date)}</time>
              {row.course?.title ? ` · ${row.course.title}` : ""}
            </span>
            <span className="truncate font-medium text-white">{row.title}</span>
            <span className="text-xs text-white/55">
              {formatMinutes(row.minutes_present)} of {formatMinutes(row.on_air_minutes)} live
              {row.short_session ? " · short class" : ""}
              {row.excused_reason ? ` · ${row.excused_reason}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <AttendanceStatus status={row.status} />
            {row.recording?.url ? (
              <Button asChild variant="secondary" size="xs">
                <Link to={row.recording.url}>
                  <Play size={12} /> Recording
                </Link>
              </Button>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function AttendancePage() {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [filters, setFilters] = useState({ course: "", status: "" });
  const [state, setState] = useState("loading"); // loading | ready | off | error
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const fail = useCallback((err) => {
    if (isAttendanceDisabledError(err)) setState("off");
    else {
      setError(errorMessage(err, "Could not load your attendance."));
      setState("error");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMySummary()
      .then((data) => {
        if (!cancelled) setSummary(data);
      })
      .catch((err) => !cancelled && fail(err));
    return () => {
      cancelled = true;
    };
  }, [fail]);

  useEffect(() => {
    let cancelled = false;
    fetchMyClasses({ ...filters, page: 1, page_size: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setRows(data?.results || []);
        setPagination(data?.pagination || null);
        setState((current) => (current === "off" ? current : "ready"));
      })
      .catch((err) => !cancelled && fail(err));
    return () => {
      cancelled = true;
    };
  }, [filters, fail]);

  const loadMore = () => {
    if (!pagination || pagination.page >= pagination.pages) return;
    setLoadingMore(true);
    fetchMyClasses({ ...filters, page: pagination.page + 1, page_size: PAGE_SIZE })
      .then((data) => {
        setRows((current) => [...current, ...(data?.results || [])]);
        setPagination(data?.pagination || null);
      })
      .catch(fail)
      .finally(() => setLoadingMore(false));
  };

  if (state === "off") {
    return (
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        <PageIntro title="Attendance" />
        <OffState />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-4 sm:p-6">
      <PageIntro title="Attendance">
        Your live-class attendance. Attended = 40+ minutes in the live class; recordings do not count.
      </PageIntro>
      <InlineError>{state === "error" ? error : ""}</InlineError>
      {summary ? <SummaryView summary={summary} /> : state === "loading" ? <Loading /> : null}
      <CourseBreakdown courses={summary?.courses || []} />
      <section aria-labelledby="att-classes" className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <h2 id="att-classes" className="text-base font-semibold text-white">
            Every class
          </h2>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Field label="Batch" labelSize="sm">
              <Select value={filters.course} onChange={(event) => setFilters((f) => ({ ...f, course: event.target.value }))}>
                <option value="">All batches</option>
                {(summary?.courses || []).map((item) =>
                  item.course?.id ? (
                    <option key={item.course.id} value={item.course.id}>
                      {item.course.title}
                    </option>
                  ) : null
                )}
              </Select>
            </Field>
            <Field label="Status" labelSize="sm">
              <Select value={filters.status} onChange={(event) => setFilters((f) => ({ ...f, status: event.target.value }))}>
                {STATUS_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
        {state === "loading" ? <Loading /> : <ClassList rows={rows} />}
        {pagination && pagination.page < pagination.pages ? (
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore} className="self-start">
            {loadingMore ? "Loading…" : "Show more classes"}
          </Button>
        ) : null}
      </section>
    </div>
  );
}
