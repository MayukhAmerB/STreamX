// Class calendar UI (views, add-to-calendar, schedule editor helpers). OWNER: WS-ATTENDANCE.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import {
  addDays,
  buildExceptionPayload,
  buildSchedulePayload,
  dayKey,
  defaultView,
  emptyScheduleForm,
  eventIcs,
  formatTimeRange,
  googleCalendarUrl,
  groupByDay,
  monthGrid,
  rangeForView,
  shiftAnchor,
  startOfWeek,
  toggleWeekday,
  weekdayOf,
} from "./calendarModel";
import { AgendaView, EventCard, MonthView } from "./CalendarParts";
import { AddToCalendarPanel, SubscribePanel, periodTitle } from "./CalendarPage";
import { PreviewList } from "./StaffCalendarPage";
import { calendarShellRoutes } from "./routes";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/calendar">{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const EVENT = {
  id: "occ-12",
  session_id: 40,
  title: "OSINT · Class 3",
  course: { id: 4, title: "OSINT Batch 7", batch: "B7" },
  starts_at: "2026-11-20T13:30:00+00:00",
  ends_at: "2026-11-20T14:30:00+00:00",
  date: "2026-11-20",
  host: { name: "Imran Syed" },
  status: "upcoming",
  kind: "regular",
  attendance: null,
  can_join: false,
  join_path: "/courses/4/live",
  recording: null,
};

describe("day maths (India time, Monday first)", () => {
  it("keys instants by the IST day", () => {
    expect(dayKey("2026-11-20T19:00:00Z")).toBe("2026-11-21"); // 00:30 IST next day
    expect(dayKey("2026-11-20T18:00:00Z")).toBe("2026-11-20");
  });

  it("walks weeks and months", () => {
    expect(weekdayOf("2026-11-16")).toBe(0); // Monday
    expect(startOfWeek("2026-11-22")).toBe("2026-11-16");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const grid = monthGrid("2026-11-15", "2026-11-15");
    expect(grid[0][0].key).toBe("2026-10-26");
    expect(grid.every((week) => week.length === 7)).toBe(true);
    expect(grid.flat().find((cell) => cell.isToday).key).toBe("2026-11-15");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(rangeForView("week", "2026-11-18")).toEqual({ from: "2026-11-16", to: "2026-11-23" });
  });

  it("opens phones on the agenda", () => {
    expect(defaultView(390)).toBe("agenda");
    expect(defaultView(1280)).toBe("month");
  });

  it("groups and labels events", () => {
    const groups = groupByDay([EVENT, { ...EVENT, id: "b", starts_at: "2026-11-20T12:00:00+00:00" }]);
    expect(groups["2026-11-20"].map((event) => event.id)).toEqual(["b", "occ-12"]);
    expect(formatTimeRange(EVENT)).toBe("7:00 PM – 8:00 PM IST");
    expect(periodTitle("agenda", "2026-11-15")).toBe("Upcoming and recent");
  });
});

describe("add to calendar", () => {
  it("builds a valid single-event .ics", () => {
    const ics = eventIcs({ ...EVENT, title: "Recon, part; 1" }, { origin: "https://alsyed.test" });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261120T133000Z");
    expect(ics).toContain("SUMMARY:Recon\\, part\\; 1");
    expect(ics).toContain("URL:https://alsyed.test/courses/4/live");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("links to Google Calendar", () => {
    const url = new URL(googleCalendarUrl(EVENT));
    expect(url.searchParams.get("dates")).toBe("20261120T133000Z/20261120T143000Z");
    expect(url.searchParams.get("ctz")).toBe("Asia/Kolkata");
  });
});

describe("views", () => {
  it("shows a class with status, time, host, join and recording", () => {
    const live = text(render(<EventCard event={{ ...EVENT, status: "live", can_join: true }} />));
    expect(live).toContain("Live now");
    expect(live).toContain("Join now");
    expect(live).toContain("Imran Syed");
    const past = render(<EventCard event={{ ...EVENT, status: "ended", attendance: "absent", recording: { url: "/learn/4?lesson=9" } }} />);
    expect(past).toContain('data-attendance="absent"');
    expect(past).toContain('href="/learn/4?lesson=9"');
    const cancelled = text(render(<EventCard event={{ ...EVENT, status: "cancelled", note: "Holiday" }} />));
    expect(cancelled).toContain("Cancelled");
    expect(cancelled).toContain("Holiday");
  });

  it("renders the agenda and the month", () => {
    expect(text(render(<AgendaView events={[EVENT]} onAddToCalendar={() => {}} />))).toContain("Add to calendar");
    expect(text(render(<AgendaView events={[]} />))).toContain("No classes");
    const month = render(<MonthView anchor="2026-11-15" events={[EVENT]} today="2026-11-15" />);
    expect(month).toContain("OSINT · Class 3");
    expect(month).toContain("<abbr");
  });

  it("offers the subscription link and per-class export", () => {
    expect(text(render(<SubscribePanel feed={{ active: false }} />))).toContain("Create my calendar link");
    const on = render(
      <SubscribePanel feed={{ active: true, url: "https://api/x.ics", webcal_url: "webcal://api/x.ics", google_url: "https://calendar.google.com/calendar/render?cid=webcal://api/x.ics" }} />
    );
    expect(on).toContain("webcal://api/x.ics");
    expect(text(on)).toContain("Turn off");
    expect(text(render(<AddToCalendarPanel event={EVENT} onClose={() => {}} />))).toContain("Google Calendar");
  });
});

describe("schedule editor", () => {
  it("validates and builds the schedule body", () => {
    const form = emptyScheduleForm("2026-11-15");
    expect(buildSchedulePayload(form).errors).toMatchObject({ course: expect.any(String), live_class: expect.any(String) });
    const { body } = buildSchedulePayload({ ...form, course: "4", live_class: "8", weekdays: toggleWeekday([4, 5, 6], 0) });
    expect(body).toMatchObject({ course: 4, live_class: 8, weekdays: [0, 4, 5, 6], start_time: "19:00", timezone: "Asia/Kolkata" });
    expect(buildSchedulePayload({ ...form, course: "4", live_class: "8", weekdays: [] }).errors.weekdays).toBeTruthy();
  });

  it("builds date changes in IST", () => {
    expect(buildExceptionPayload({ kind: "cancelled", date: "2026-11-20", note: "Holiday" }).body).toEqual({
      kind: "cancelled",
      date: "2026-11-20",
      note: "Holiday",
      title: "",
    });
    expect(buildExceptionPayload({ kind: "rescheduled", date: "2026-11-20", newDate: "2026-11-21", newTime: "20:00" }).body.new_start).toBe(
      "2026-11-21T20:00:00+05:30"
    );
    expect(buildExceptionPayload({ kind: "extra", newDate: "", newTime: "" }).error).toBeTruthy();
  });

  it("previews generated dates", () => {
    const html = text(
      render(
        <PreviewList
          preview={{
            count: 1,
            cancelled: 1,
            occurrences: [
              { key: "a", date: "2026-11-20", local_time: "19:00", status: "scheduled", kind: "regular", title: "Class 1" },
              { key: "b", date: "2026-11-21", local_time: "19:00", status: "cancelled", kind: "regular", title: "" },
            ],
          }}
        />
      )
    );
    expect(html).toContain("1 class, 1 cancelled");
    expect(html).toContain("Cancelled");
  });

  it("exposes three routes", () => {
    expect(calendarShellRoutes()).toHaveLength(3);
  });
});
