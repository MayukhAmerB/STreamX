// Staff / instructor Console page "Attendance". OWNER: WS-ATTENDANCE.
// Tabs: Classes (live now + finished, roster with corrections), Batch matrix
// (students × dates, CSV) and Follow-up (below 75 %, CSV). Instructors see
// their own batches; staff see every batch (the server enforces both).
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../kit/Button";
import { Card } from "../../kit/Card";
import { Field, Input, Select, Textarea } from "../../kit/Form";
import { LiveDot } from "../../kit/Badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../kit/Tabs";

import {
  downloadCsv,
  errorMessage,
  fetchLowAttendance,
  fetchMatrix,
  fetchRoster,
  fetchStaffCourses,
  fetchStaffSessions,
  isAttendanceDisabledError,
  overrideAttendance,
} from "./attendanceApi";
import {
  OVERRIDE_OPTIONS,
  buildOverride,
  filterRoster,
  formatDate,
  formatMinutes,
  formatPercent,
  formatTime,
  matrixSymbol,
  rosterCounts,
  statusMeta,
} from "./attendanceModel";
import { AttendanceStatus, InlineError, Loading, OffState, PageIntro } from "./AttendanceParts";

const LIVE_REFRESH_MS = 30_000;

function CourseSelect({ courses, value, onChange, allowAll = true, label = "Batch" }) {
  return (
    <Field label={label} labelSize="sm">
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {allowAll ? <option value="">All batches</option> : <option value="">Pick a batch</option>}
        {courses.map((course) => (
          <option key={course.id} value={course.id}>
            {course.title}
            {course.batch ? ` · ${course.batch}` : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function SessionRow({ row, active, onOpen }) {
  const counts = row.counts || {};
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.session_id)}
        aria-pressed={active}
        className={`flex w-full flex-col gap-1 p-4 text-left transition-colors hover:bg-white/[.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${active ? "bg-white/[.06]" : ""}`}
      >
        <span className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/55">
          {row.status === "live" ? (
            <>
              <LiveDot /> <span className="text-accent">Live now</span>
            </>
          ) : (
            formatDate(row.date)
          )}
          {row.course?.title ? ` · ${row.course.title}` : ""}
          {row.short_session ? " · Short class" : ""}
        </span>
        <span className="font-medium text-white">{row.title}</span>
        {row.status !== "live" ? (
          <span className="text-xs tabular-nums text-white/65">
            {counts.present ?? 0} attended · {counts.partial ?? 0} partial · {counts.absent ?? 0} absent
            {counts.excused ? ` · ${counts.excused} excused` : ""} · {formatPercent(row.attendance_percent)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export function RosterTable({ data, onCorrect }) {
  const [query, setQuery] = useState("");
  const rows = filterRoster(data?.rows || [], query);
  const counts = rosterCounts(data?.rows || []);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-white/65">
        {data?.live ? <span>{counts.online} online now ·</span> : null}
        <span>
          {counts.present} attended · {counts.partial} partial · {counts.absent + counts.not_joined} not attended
          {counts.excused ? ` · ${counts.excused} excused` : ""}
        </span>
        {data?.summary?.short_session ? (
          <span className="rounded-full border border-accent/40 px-2 py-0.5 text-accent">
            Short class: {data.summary.on_air_minutes} min live, bar {data.summary.threshold_minutes} min
          </span>
        ) : null}
      </div>
      <Field label="Find a student" labelSize="sm">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or email" />
      </Field>
      <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
        {rows.map((row) => (
          <li key={row.user.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2 truncate font-medium text-white">
                {row.online ? <LiveDot /> : null}
                {row.user.name}
              </span>
              <span className="truncate text-xs text-white/55">
                {row.user.email} · {formatMinutes(row.minutes_present)}
                {row.first_joined_at ? ` · joined ${formatTime(row.first_joined_at)}` : ""}
                {row.manual_override ? ` · corrected: ${row.override_reason}` : ""}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <AttendanceStatus status={row.status} />
              {onCorrect ? (
                <Button variant="ghost" size="xs" onClick={() => onCorrect(row)}>
                  Correct
                </Button>
              ) : null}
            </div>
          </li>
        ))}
        {!rows.length ? <li className="p-3 text-sm text-white/55">No students match.</li> : null}
      </ul>
    </div>
  );
}

function CorrectionForm({ row, sessionId, onDone, onCancel }) {
  const [status, setStatus] = useState(row.status === "excused" ? "auto" : "excused");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = (event) => {
    event.preventDefault();
    const built = buildOverride({ userId: row.user.id, status, reason });
    if (built.error) {
      setError(built.error);
      return;
    }
    setSaving(true);
    overrideAttendance(sessionId, built.body)
      .then(() => onDone())
      .catch((err) => setError(errorMessage(err, "Could not save the correction.")))
      .finally(() => setSaving(false));
  };
  return (
    <Card tone="raised" className="flex flex-col gap-3 p-4">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-white">
          Correct attendance for <strong>{row.user.name}</strong> (now {statusMeta(row.status).label.toLowerCase()}).
        </p>
        <Field label="New status" labelSize="sm">
          <Select value={status} onChange={(event) => setStatus(event.target.value)}>
            {OVERRIDE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason (kept in the audit log)" labelSize="sm">
          <Textarea rows={2} value={reason} maxLength={300} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <InlineError>{error}</InlineError>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save correction"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ClassesTab({ courses }) {
  const [filters, setFilters] = useState({ course: "", from: "", to: "", short: "" });
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [roster, setRoster] = useState(null);
  const [correcting, setCorrecting] = useState(null);
  const [error, setError] = useState("");

  const loadList = useCallback(() => {
    fetchStaffSessions(filters)
      .then(setList)
      .catch((err) => setError(errorMessage(err, "Could not load classes.")));
  }, [filters]);
  useEffect(loadList, [loadList]);

  const loadRoster = useCallback(() => {
    if (!openId) return;
    fetchRoster(openId)
      .then(setRoster)
      .catch((err) => setError(errorMessage(err, "Could not load the roster.")));
  }, [openId]);
  useEffect(loadRoster, [loadRoster]);

  // A live roster refreshes every 30 s while the tab is visible.
  useEffect(() => {
    if (!roster?.live || typeof window === "undefined") return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") loadRoster();
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [roster?.live, loadRoster]);

  const rows = useMemo(() => [...(list?.live || []), ...(list?.results || [])], [list]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <CourseSelect courses={courses} value={filters.course} onChange={(course) => setFilters((f) => ({ ...f, course }))} />
          <Field label="Only short classes" labelSize="sm">
            <Select value={filters.short} onChange={(event) => setFilters((f) => ({ ...f, short: event.target.value }))}>
              <option value="">All classes</option>
              <option value="1">Short classes</option>
            </Select>
          </Field>
          <Field label="From" labelSize="sm">
            <Input type="date" value={filters.from} onChange={(event) => setFilters((f) => ({ ...f, from: event.target.value }))} />
          </Field>
          <Field label="To" labelSize="sm">
            <Input type="date" value={filters.to} onChange={(event) => setFilters((f) => ({ ...f, to: event.target.value }))} />
          </Field>
        </div>
        <InlineError>{error}</InlineError>
        {!list ? (
          <Loading />
        ) : rows.length ? (
          <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
            {rows.map((row) => (
              <SessionRow key={row.session_id} row={row} active={row.session_id === openId} onOpen={setOpenId} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/55">No classes for these filters.</p>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {!openId ? (
          <p className="text-sm text-white/55">Pick a class to see who attended.</p>
        ) : !roster ? (
          <Loading />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-white">{roster.session?.title}</h3>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => downloadCsv("roster", { sessionId: openId, filename: `attendance-class-${openId}.csv` }).catch(() => {})}
              >
                Download CSV
              </Button>
            </div>
            {correcting ? (
              <CorrectionForm
                row={correcting}
                sessionId={openId}
                onCancel={() => setCorrecting(null)}
                onDone={() => {
                  setCorrecting(null);
                  loadRoster();
                  loadList();
                }}
              />
            ) : null}
            <RosterTable data={roster} onCorrect={setCorrecting} />
          </>
        )}
      </div>
    </div>
  );
}

export function MatrixTable({ data }) {
  if (!data?.sessions?.length) return <p className="text-sm text-white/55">No finished classes for this batch yet.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Attendance of {data.course?.title}: students by class date</caption>
        <thead>
          <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide text-white/55">
            <th scope="col" className="sticky left-0 bg-black p-2">
              Student
            </th>
            {data.sessions.map((item) => (
              <th key={item.session_id} scope="col" className="whitespace-nowrap p-2 font-medium" title={item.title}>
                {formatDate(item.date, { withYear: false })}
                {item.short_session ? " *" : ""}
              </th>
            ))}
            <th scope="col" className="p-2">
              %
            </th>
          </tr>
        </thead>
        <tbody>
          {data.students.map((row) => (
            <tr key={row.user.id} className="border-b border-white/5">
              <th scope="row" className="sticky left-0 max-w-[12rem] truncate bg-black p-2 text-left font-medium text-white">
                {row.user.name}
              </th>
              {row.cells.map((cell, index) => (
                <td
                  key={data.sessions[index].session_id}
                  className={`p-2 text-center ${cell === "present" ? "text-white" : "text-white/45"}`}
                  title={cell ? statusMeta(cell).label : "Not enrolled yet"}
                >
                  <span aria-hidden="true">{matrixSymbol(cell)}</span>
                  <span className="sr-only">{cell ? statusMeta(cell).label : "Not enrolled yet"}</span>
                </td>
              ))}
              <td className="p-2 tabular-nums text-white">{formatPercent(row.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="p-2 text-xs text-white/55">● attended · ◐ partial · ○ absent · E excused · * short class</p>
    </div>
  );
}

function MatrixTab({ courses }) {
  const [course, setCourse] = useState("");
  const [range, setRange] = useState({ from: "", to: "" });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!course) {
      setData(null);
      return;
    }
    setError("");
    fetchMatrix({ course, ...range })
      .then(setData)
      .catch((err) => setError(errorMessage(err, "Could not load the matrix.")));
  }, [course, range]);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <CourseSelect courses={courses} value={course} onChange={setCourse} allowAll={false} />
        <Field label="From" labelSize="sm">
          <Input type="date" value={range.from} onChange={(event) => setRange((r) => ({ ...r, from: event.target.value }))} />
        </Field>
        <Field label="To" labelSize="sm">
          <Input type="date" value={range.to} onChange={(event) => setRange((r) => ({ ...r, to: event.target.value }))} />
        </Field>
        <div className="flex items-end">
          <Button
            variant="secondary"
            size="sm"
            disabled={!course}
            onClick={() => downloadCsv("matrix", { params: { course, ...range }, filename: `attendance-batch-${course}.csv` }).catch(() => {})}
          >
            Download CSV
          </Button>
        </div>
      </div>
      <InlineError>{error}</InlineError>
      {course ? data ? <MatrixTable data={data} /> : <Loading /> : <p className="text-sm text-white/55">Pick a batch.</p>}
    </div>
  );
}

export function FollowUpList({ data }) {
  if (!data?.results?.length) return <p className="text-sm text-white/55">Everyone is at or above {data?.threshold ?? 75}%.</p>;
  return (
    <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
      {data.results.map((row) => (
        <li key={`${row.user.id}-${row.course?.id}`} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-white">{row.user.name}</span>
            <span className="truncate text-xs text-white/55">
              {row.user.email} · {row.course?.title}
              {row.last_class ? ` · last class ${formatDate(row.last_class, { withYear: false })}` : ""}
            </span>
          </div>
          <span className="shrink-0 text-sm tabular-nums text-white">
            {row.attended}/{row.total} · {formatPercent(row.percent)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FollowUpTab({ courses }) {
  const [course, setCourse] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setError("");
    fetchLowAttendance({ course })
      .then(setData)
      .catch((err) => setError(errorMessage(err, "Could not load the list.")));
  }, [course]);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <CourseSelect courses={courses} value={course} onChange={setCourse} />
        <div className="flex items-end">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => downloadCsv("low", { params: { course }, filename: "low-attendance.csv" }).catch(() => {})}
          >
            Download CSV
          </Button>
        </div>
      </div>
      <p className="text-sm text-white/65">Students below {data?.threshold ?? 75}% attendance, lowest first.</p>
      <InlineError>{error}</InlineError>
      {data ? <FollowUpList data={data} /> : <Loading />}
    </div>
  );
}

export default function StaffAttendancePage() {
  const [courses, setCourses] = useState([]);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    fetchStaffCourses()
      .then((data) => {
        setCourses(data?.courses || []);
        setState("ready");
      })
      .catch((err) => {
        if (isAttendanceDisabledError(err)) setState("off");
        else {
          setError(errorMessage(err, "You cannot open attendance reports."));
          setState("error");
        }
      });
  }, []);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageIntro title="Attendance">
        Who attended each live class (attended = 40+ minutes live), batch registers and students to follow up.
      </PageIntro>
      {state === "off" ? <OffState /> : null}
      <InlineError>{state === "error" ? error : ""}</InlineError>
      {state === "loading" ? <Loading /> : null}
      {state === "ready" ? (
        <Tabs defaultValue="classes">
          <TabsList aria-label="Attendance views">
            <TabsTrigger value="classes">Classes</TabsTrigger>
            <TabsTrigger value="matrix">Batch register</TabsTrigger>
            <TabsTrigger value="follow-up">Follow-up</TabsTrigger>
          </TabsList>
          <TabsContent value="classes" className="pt-4">
            <ClassesTab courses={courses} />
          </TabsContent>
          <TabsContent value="matrix" className="pt-4">
            <MatrixTab courses={courses} />
          </TabsContent>
          <TabsContent value="follow-up" className="pt-4">
            <FollowUpTab courses={courses} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
