// Staff / instructor Console page "Calendar". OWNER: WS-ATTENDANCE (calendar).
// Every batch's classes (filter by batch and host) and the timetable editor:
// a schedule (weekdays, time, duration, IST) with a preview of the dates it
// will create before saving, plus one-off changes (cancel, move, extra class).
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../../kit/Button";
import { Card } from "../../kit/Card";
import { Checkbox, Field, Input, Select, Textarea } from "../../kit/Form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../kit/Tabs";

import { errorMessage, isAttendanceDisabledError } from "../attendance/attendanceApi";
import { InlineError, Loading, OffState, PageIntro } from "../attendance/AttendanceParts";
import {
  addScheduleException,
  createSchedule,
  fetchSchedule,
  fetchSchedules,
  fetchStaffEvents,
  fetchStaffOptions,
  pauseSchedule,
  previewSchedule,
  removeScheduleException,
  updateSchedule,
} from "./calendarApi";
import {
  WEEKDAYS,
  buildExceptionPayload,
  buildSchedulePayload,
  emptyScheduleForm,
  formatDayHeading,
  rangeForView,
  scheduleToForm,
  shiftAnchor,
  todayKey,
  toggleWeekday,
} from "./calendarModel";
import { AgendaView, EventCard, MonthView, ViewSwitch, WeekView } from "./CalendarParts";
import { periodTitle } from "./CalendarPage";

function EventsTab({ options }) {
  const [view, setView] = useState(() => (typeof window !== "undefined" && window.innerWidth <= 640 ? "agenda" : "month"));
  const [anchor, setAnchor] = useState(() => todayKey());
  const [filters, setFilters] = useState({ course: "", host: "" });
  const [events, setEvents] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const range = useMemo(() => rangeForView(view, anchor), [view, anchor]);
  useEffect(() => {
    setEvents(null);
    fetchStaffEvents({ ...range, ...filters })
      .then((data) => setEvents(data?.events || []))
      .catch((err) => setError(errorMessage(err, "Could not load the calendar.")));
  }, [range, filters]);
  const today = todayKey();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Batch" labelSize="sm">
          <Select value={filters.course} onChange={(event) => setFilters((f) => ({ ...f, course: event.target.value }))}>
            <option value="">All batches</option>
            {options.courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </Select>
        </Field>
        {options.is_staff ? (
          <Field label="Host" labelSize="sm">
            <Select value={filters.host} onChange={(event) => setFilters((f) => ({ ...f, host: event.target.value }))}>
              <option value="">Any host</option>
              {options.hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <ViewSwitch view={view} onChange={setView} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="secondary" onClick={() => setAnchor((a) => shiftAnchor(view, a, -1))}>
          Previous
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setAnchor((a) => shiftAnchor(view, a, 1))}>
          Next
        </Button>
        <h2 className="ml-2 text-base font-semibold text-white">{periodTitle(view, anchor)}</h2>
      </div>
      <InlineError>{error}</InlineError>
      {events === null ? (
        <Loading />
      ) : view === "agenda" ? (
        <AgendaView events={events} staff />
      ) : (
        <>
          {view === "month" ? (
            <MonthView anchor={anchor} events={events} onSelect={setSelected} today={today} />
          ) : (
            <WeekView anchor={anchor} events={events} onSelect={setSelected} today={today} />
          )}
          {selected ? <EventCard event={selected} staff /> : null}
        </>
      )}
    </div>
  );
}

export function PreviewList({ preview }) {
  if (!preview) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-white">
        {preview.count} {preview.count === 1 ? "class" : "classes"}
        {preview.cancelled ? `, ${preview.cancelled} cancelled` : ""} · times in IST
      </p>
      <ol className="max-h-72 overflow-y-auto rounded-lg border border-white/10 text-sm">
        {preview.occurrences.map((occ) => (
          <li
            key={occ.key}
            className={`flex justify-between gap-3 border-b border-white/5 px-3 py-2 ${occ.status === "cancelled" ? "text-white/40 line-through" : "text-white/85"}`}
          >
            <span className="truncate">
              {formatDayHeading(occ.date)} · {occ.local_time}
            </span>
            <span className="truncate text-white/55">
              {occ.status === "cancelled" ? "Cancelled" : occ.kind === "extra" ? "Extra" : occ.kind === "rescheduled" ? "Moved" : occ.title}
            </span>
          </li>
        ))}
      </ol>
      {preview.truncated ? <p className="text-xs text-white/55">Showing the first classes only.</p> : null}
    </div>
  );
}

function ScheduleForm({ options, initial, scheduleId, onSaved, onCancel }) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (name) => (event) => {
    setForm((current) => ({ ...current, [name]: event.target.value }));
    setPreview(null);
  };
  const liveClasses = options.live_classes.filter((item) => String(item.course_id) === String(form.course));

  const run = (action) => {
    const built = buildSchedulePayload(form);
    if (built.errors) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setMessage("");
    setBusy(true);
    action(built.body)
      .catch((err) => {
        const details = err?.response?.data?.errors;
        if (details && typeof details === "object") {
          setErrors(Object.fromEntries(Object.entries(details).map(([key, value]) => [key, Array.isArray(value) ? value.join(" ") : String(value)])));
        }
        setMessage(errorMessage(err, "Could not save the schedule."));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Card tone="surface" className="flex flex-col gap-4 p-4">
      <h3 className="text-base font-semibold text-white">{scheduleId ? "Edit schedule" : "New schedule"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Batch" labelSize="sm" error={errors.course}>
          <Select value={form.course} onChange={set("course")}>
            <option value="">Pick a batch</option>
            {options.courses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Live class students join" labelSize="sm" error={errors.live_class}>
          <Select value={form.live_class} onChange={set("live_class")}>
            <option value="">Pick a live class</option>
            {liveClasses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name (optional)" labelSize="sm" error={errors.name}>
          <Input value={form.name} onChange={set("name")} placeholder="Batch 7, term 1" />
        </Field>
        <Field label="Class title" labelSize="sm" hint="{course}, {batch}, {n}, {date}, {weekday}" error={errors.title_pattern}>
          <Input value={form.title_pattern} onChange={set("title_pattern")} />
        </Field>
        <Field label="First date" labelSize="sm" error={errors.start_date}>
          <Input type="date" value={form.start_date} onChange={set("start_date")} />
        </Field>
        <Field label="Last date" labelSize="sm" error={errors.end_date}>
          <Input type="date" value={form.end_date} onChange={set("end_date")} />
        </Field>
        <Field label="Start time (IST)" labelSize="sm" error={errors.start_time}>
          <Input type="time" value={form.start_time} onChange={set("start_time")} />
        </Field>
        <Field label="Length (minutes)" labelSize="sm" error={errors.duration_minutes}>
          <Input type="number" min={15} max={600} value={form.duration_minutes} onChange={set("duration_minutes")} />
        </Field>
        {options.is_staff ? (
          <Field label="Host" labelSize="sm" error={errors.host}>
            <Select value={form.host} onChange={set("host")}>
              <option value="">Me</option>
              {options.hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Class type" labelSize="sm">
          <Select value={form.session_type} onChange={set("session_type")}>
            <option value="meeting">Meeting</option>
            <option value="broadcasting">Broadcast</option>
          </Select>
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-white">Weekdays</legend>
        <div className="flex flex-wrap gap-3">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className="inline-flex items-center gap-2 text-sm text-white/80">
              <Checkbox
                checked={form.weekdays.includes(day.value)}
                onCheckedChange={() => {
                  setForm((current) => ({ ...current, weekdays: toggleWeekday(current.weekdays, day.value) }));
                  setPreview(null);
                }}
                aria-label={day.label}
              />
              {day.short}
            </label>
          ))}
        </div>
        <InlineError>{errors.weekdays}</InlineError>
      </fieldset>
      <Field label="Description (optional)" labelSize="sm">
        <Textarea rows={2} value={form.description} onChange={set("description")} />
      </Field>
      <InlineError>{message}</InlineError>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run((body) => previewSchedule(body).then(setPreview))}>
          Preview dates
        </Button>
        <Button
          size="sm"
          disabled={busy || !preview}
          title={preview ? undefined : "Preview the dates first"}
          onClick={() =>
            run((body) =>
              (scheduleId ? updateSchedule(scheduleId, { ...body, exceptions: undefined }) : createSchedule(body)).then(onSaved)
            )
          }
        >
          {scheduleId ? "Save changes" : "Save schedule"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <PreviewList preview={preview} />
    </Card>
  );
}

function ExceptionForm({ schedule, onChanged }) {
  const [draft, setDraft] = useState({ kind: "cancelled", date: "", newDate: "", newTime: "", note: "", title: "" });
  const [error, setError] = useState("");
  const dates = (schedule.next_occurrences || []).filter((occ) => occ.kind !== "extra");
  const set = (name) => (event) => setDraft((current) => ({ ...current, [name]: event.target.value }));
  const submit = (event) => {
    event.preventDefault();
    const built = buildExceptionPayload(draft);
    if (built.error) {
      setError(built.error);
      return;
    }
    setError("");
    addScheduleException(schedule.id, built.body)
      .then((data) => {
        setDraft({ kind: "cancelled", date: "", newDate: "", newTime: "", note: "", title: "" });
        onChanged(data);
      })
      .catch((err) => setError(errorMessage(err, "Could not save the change.")));
  };
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <Field label="Change" labelSize="sm">
        <Select value={draft.kind} onChange={set("kind")}>
          <option value="cancelled">Cancel a class</option>
          <option value="rescheduled">Move a class</option>
          <option value="extra">Add an extra class</option>
        </Select>
      </Field>
      {draft.kind !== "extra" ? (
        <Field label="Class date" labelSize="sm">
          <Select value={draft.date} onChange={set("date")}>
            <option value="">Pick a date</option>
            {dates.map((occ) => (
              <option key={occ.key} value={occ.date}>
                {formatDayHeading(occ.date)} · {occ.local_time}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {draft.kind !== "cancelled" ? (
        <>
          <Field label="New date" labelSize="sm">
            <Input type="date" value={draft.newDate} onChange={set("newDate")} />
          </Field>
          <Field label="New time (IST)" labelSize="sm">
            <Input type="time" value={draft.newTime} onChange={set("newTime")} />
          </Field>
        </>
      ) : null}
      {draft.kind === "extra" ? (
        <Field label="Title (optional)" labelSize="sm">
          <Input value={draft.title} onChange={set("title")} placeholder="Doubt clearing" />
        </Field>
      ) : null}
      <Field label="Note for students (optional)" labelSize="sm">
        <Input value={draft.note} onChange={set("note")} maxLength={300} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <InlineError>{error}</InlineError>
        <Button type="submit" size="sm" variant="secondary" className="self-start">
          Save change (students are notified)
        </Button>
      </div>
    </form>
  );
}

function ScheduleDetail({ scheduleId, options, onBack, onEdited }) {
  const [schedule, setSchedule] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    fetchSchedule(scheduleId)
      .then(setSchedule)
      .catch((err) => setError(errorMessage(err, "Could not load the schedule.")));
  }, [scheduleId]);
  useEffect(load, [load]);
  if (!schedule) return error ? <InlineError>{error}</InlineError> : <Loading />;
  if (editing) {
    return (
      <ScheduleForm
        options={options}
        initial={scheduleToForm(schedule)}
        scheduleId={schedule.id}
        onCancel={() => setEditing(false)}
        onSaved={(data) => {
          setSchedule(data);
          setEditing(false);
          onEdited();
        }}
      />
    );
  }
  const days = schedule.weekdays.map((day) => WEEKDAYS[day]?.short).join(", ");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="ghost" onClick={onBack}>
          All schedules
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setEditing(true)}>
          Edit
        </Button>
        {schedule.is_active ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              pauseSchedule(schedule.id)
                .then(() => {
                  load();
                  onEdited();
                })
                .catch((err) => setError(errorMessage(err)))
            }
          >
            Pause (cancels upcoming classes)
          </Button>
        ) : null}
      </div>
      <Card tone="surface" className="flex flex-col gap-1 p-4">
        <h3 className="text-base font-semibold text-white">{schedule.name || schedule.course.title}</h3>
        <p className="text-sm text-white/65">
          {schedule.course.title} · {days} at {schedule.start_time} IST for {schedule.duration_minutes} min · {schedule.start_date} to{" "}
          {schedule.end_date} · host {schedule.host.name}
          {schedule.is_active ? "" : " · paused"}
        </p>
      </Card>
      <InlineError>{error}</InlineError>
      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold text-white">Next classes</h4>
        <ol className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10 text-sm">
          {(schedule.next_occurrences || []).map((occ) => (
            <li key={occ.key} className={`flex justify-between gap-3 px-3 py-2 ${occ.status === "cancelled" ? "text-white/40 line-through" : "text-white/85"}`}>
              <span>
                {formatDayHeading(occ.date)} · {occ.local_time}
              </span>
              <span className="truncate text-white/55">{occ.title}</span>
            </li>
          ))}
        </ol>
      </section>
      {schedule.exceptions.length ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-white">Changes</h4>
          <ul className="flex flex-col gap-2">
            {schedule.exceptions.map((exc) => (
              <li key={exc.id} className="flex items-center justify-between gap-3 rounded border border-white/10 px-3 py-2 text-sm text-white/80">
                <span>
                  {exc.kind === "cancelled" ? "Cancelled" : exc.kind === "extra" ? "Extra class" : "Moved"} · {formatDayHeading(exc.date)}
                  {exc.note ? ` · ${exc.note}` : ""}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => removeScheduleException(exc.id).then(load).catch((err) => setError(errorMessage(err)))}
                >
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {schedule.is_active ? (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-white">Change one date</h4>
          <ExceptionForm schedule={schedule} onChanged={(data) => setSchedule(data)} />
        </section>
      ) : null}
    </div>
  );
}

function SchedulesTab({ options }) {
  const [schedules, setSchedules] = useState(null);
  const [mode, setMode] = useState({ kind: "list" });
  const [error, setError] = useState("");
  const load = useCallback(() => {
    fetchSchedules()
      .then((data) => setSchedules(data?.schedules || []))
      .catch((err) => setError(errorMessage(err, "Could not load schedules.")));
  }, []);
  useEffect(load, [load]);

  if (mode.kind === "new") {
    return (
      <ScheduleForm
        options={options}
        initial={emptyScheduleForm()}
        onCancel={() => setMode({ kind: "list" })}
        onSaved={(data) => {
          load();
          setMode({ kind: "detail", id: data.id });
        }}
      />
    );
  }
  if (mode.kind === "detail") {
    return <ScheduleDetail scheduleId={mode.id} options={options} onBack={() => setMode({ kind: "list" })} onEdited={load} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <Button size="sm" className="self-start" onClick={() => setMode({ kind: "new" })}>
        New schedule
      </Button>
      <InlineError>{error}</InlineError>
      {schedules === null ? (
        <Loading />
      ) : schedules.length ? (
        <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
          {schedules.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setMode({ kind: "detail", id: item.id })}
                className="flex w-full flex-col gap-1 p-4 text-left hover:bg-white/[.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="font-medium text-white">
                  {item.name || item.course.title}
                  {item.is_active ? "" : " · paused"}
                </span>
                <span className="text-xs text-white/55">
                  {item.weekdays.map((day) => WEEKDAYS[day]?.short).join(", ")} at {item.start_time} IST · {item.start_date} to {item.end_date} ·{" "}
                  {item.host.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-white/55">No schedules yet. Create one to fill the calendar automatically.</p>
      )}
    </div>
  );
}

export default function StaffCalendarPage() {
  const [options, setOptions] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    fetchStaffOptions()
      .then((data) => {
        setOptions(data);
        setState("ready");
      })
      .catch((err) => {
        if (isAttendanceDisabledError(err)) setState("off");
        else {
          setError(errorMessage(err, "You cannot open the class calendar."));
          setState("error");
        }
      });
  }, []);
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageIntro title="Class calendar">
        Every batch's live classes. Schedules create upcoming classes automatically (30 days ahead, India time).
      </PageIntro>
      {state === "off" ? <OffState title="The class calendar is switched off" /> : null}
      <InlineError>{state === "error" ? error : ""}</InlineError>
      {state === "loading" ? <Loading /> : null}
      {state === "ready" && options ? (
        <Tabs defaultValue="calendar">
          <TabsList aria-label="Calendar views">
            <TabsTrigger value="calendar">Calendar</TabsTrigger>
            <TabsTrigger value="schedules">Schedules</TabsTrigger>
          </TabsList>
          <TabsContent value="calendar" className="pt-4">
            <EventsTab options={options} />
          </TabsContent>
          <TabsContent value="schedules" className="pt-4">
            <SchedulesTab options={options} />
          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
