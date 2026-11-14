// Calendar views shared by the student and staff pages. OWNER: WS-ATTENDANCE (calendar).
// Palette law: status = icon + label + luminance (the golden live dot is the one glow).
import { Link } from "react-router-dom";

import { LiveDot } from "../../kit/Badge";
import { Button } from "../../kit/Button";
import { CheckCircle, Clock, Close, Play } from "../../kit/icons";
import { cn } from "../../kit/lib/cn";

import { AttendanceStatus } from "../attendance/AttendanceParts";
import {
  WEEKDAYS,
  eventStatus,
  formatClock,
  formatDayHeading,
  formatTimeRange,
  groupByDay,
  monthGrid,
  weekKeys,
} from "./calendarModel";

const STATUS_ICON = { clock: Clock, check: CheckCircle, close: Close };
const TONE = {
  accent: "border-accent/40 text-accent",
  mid: "border-white/25 text-white/80",
  dim: "border-dashed border-white/20 text-white/50",
};

export function EventStatus({ status }) {
  const meta = eventStatus(status);
  const Icon = STATUS_ICON[meta.icon];
  return (
    <span
      data-event-status={status}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide", TONE[meta.tone])}
    >
      {meta.icon === "live" ? <LiveDot /> : Icon ? <Icon size={12} /> : null}
      <span>{meta.label}</span>
    </span>
  );
}

/** One class: title, batch, time (IST), host, status, attendance, join / recording / add-to-calendar. */
export function EventCard({ event, onAddToCalendar, staff = false }) {
  const cancelled = event.status === "cancelled";
  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-4",
        event.status === "live" ? "border-accent/40 bg-white/[.04]" : "border-white/10",
        cancelled && "opacity-70"
      )}
      aria-label={`${event.title}, ${formatTimeRange(event)}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <EventStatus status={event.status} />
        {event.attendance ? <AttendanceStatus status={event.attendance} /> : null}
        {event.kind === "extra" ? <span className="text-xs uppercase tracking-wide text-white/55">Extra class</span> : null}
        {event.kind === "rescheduled" ? <span className="text-xs uppercase tracking-wide text-white/55">Moved</span> : null}
      </div>
      <h3 className={cn("font-medium text-white", cancelled && "line-through decoration-white/40")}>{event.title}</h3>
      <p className="text-sm text-white/65">
        {formatTimeRange(event)}
        {event.course?.title ? ` · ${event.course.title}` : ""}
        {event.course?.batch ? ` (${event.course.batch})` : ""}
        {event.host?.name ? ` · ${event.host.name}` : ""}
      </p>
      {event.note ? <p className="text-sm text-white/55">{event.note}</p> : null}
      {staff && event.counts ? (
        <p className="text-xs tabular-nums text-white/55">
          {event.counts.present} attended · {event.counts.partial} partial · {event.counts.absent} absent
          {event.counts.short_session ? " · short class" : ""}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {event.can_join && !staff ? (
          <Button asChild size="xs" variant="accent">
            <Link to={event.join_path}>Join now</Link>
          </Button>
        ) : null}
        {event.recording?.url ? (
          <Button asChild size="xs" variant="secondary">
            <Link to={event.recording.url}>
              <Play size={12} /> Recording
            </Link>
          </Button>
        ) : null}
        {onAddToCalendar && event.status === "upcoming" ? (
          <Button size="xs" variant="ghost" onClick={() => onAddToCalendar(event)}>
            Add to calendar
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function AgendaView({ events = [], onAddToCalendar, staff = false, emptyText = "No classes in this period." }) {
  const groups = groupByDay(events);
  const keys = Object.keys(groups).sort();
  if (!keys.length) return <p className="text-sm text-white/55">{emptyText}</p>;
  return (
    <ol className="flex flex-col gap-6">
      {keys.map((key) => (
        <li key={key} className="flex flex-col gap-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-white/55">
            <time dateTime={key}>{formatDayHeading(key)}</time>
          </h3>
          <ul className="flex flex-col gap-3">
            {groups[key].map((event) => (
              <li key={event.id}>
                <EventCard event={event} onAddToCalendar={onAddToCalendar} staff={staff} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function DayChip({ event, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(event)}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded border px-1.5 py-0.5 text-left text-[11px] leading-4",
        event.status === "live" ? "border-accent/40 text-accent" : event.status === "cancelled" ? "border-dashed border-white/15 text-white/40 line-through" : "border-white/15 text-white/80",
        "hover:bg-white/[.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      )}
      title={`${event.title} · ${formatTimeRange(event)}`}
    >
      {event.status === "live" ? <LiveDot className="shrink-0" /> : null}
      <span className="tabular-nums">{formatClock(event.starts_at)}</span>
      <span className="truncate">{event.title}</span>
    </button>
  );
}

export function MonthView({ anchor, events = [], onSelect, today }) {
  const groups = groupByDay(events);
  const weeks = monthGrid(anchor, today);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[42rem] table-fixed border-collapse text-sm">
        <thead>
          <tr>
            {WEEKDAYS.map((day) => (
              <th key={day.value} scope="col" className="p-2 text-left text-xs font-medium uppercase tracking-wide text-white/55">
                <abbr title={day.label} className="no-underline">
                  {day.short}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0].key}>
              {week.map((cell) => (
                <td
                  key={cell.key}
                  className={cn("h-24 border border-white/10 p-1 align-top", !cell.inMonth && "bg-white/[.02] text-white/35")}
                >
                  <div className={cn("mb-1 text-xs tabular-nums", cell.isToday ? "font-semibold text-black" : "text-white/60")}>
                    <span className={cn(cell.isToday && "rounded bg-white px-1.5 py-0.5")}>{Number(cell.key.slice(8))}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {(groups[cell.key] || []).slice(0, 3).map((event) => (
                      <DayChip key={event.id} event={event} onSelect={onSelect} />
                    ))}
                    {(groups[cell.key] || []).length > 3 ? (
                      <span className="text-[11px] text-white/55">+{groups[cell.key].length - 3} more</span>
                    ) : null}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WeekView({ anchor, events = [], onSelect, today }) {
  const groups = groupByDay(events);
  return (
    <ol className="grid gap-2 md:grid-cols-7">
      {weekKeys(anchor).map((key, index) => (
        <li key={key} className={cn("flex min-h-32 flex-col gap-2 rounded-lg border border-white/10 p-2", key === today && "border-white/40")}>
          <span className="text-xs uppercase tracking-wide text-white/55">
            {WEEKDAYS[index].short} {Number(key.slice(8))}
          </span>
          {(groups[key] || []).map((event) => (
            <DayChip key={event.id} event={event} onSelect={onSelect} />
          ))}
        </li>
      ))}
    </ol>
  );
}

export function ViewSwitch({ view, onChange }) {
  return (
    <div role="group" aria-label="Calendar view" className="inline-flex rounded-md border border-white/15 p-0.5">
      {["month", "week", "agenda"].map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={cn(
            "rounded px-3 py-1.5 text-xs font-medium capitalize",
            view === value ? "bg-white text-black" : "text-white/75 hover:bg-white/[.06]"
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
