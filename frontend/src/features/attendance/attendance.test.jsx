// Attendance UI (student page, staff reports, live presence loop). OWNER: WS-ATTENDANCE.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildShellNav, getWorkspaceItems } from "../app-shell/navConfig";
import { isAttendanceDisabledError } from "./attendanceApi";
import {
  buildOverride,
  filterRoster,
  formatMinutes,
  formatPercent,
  matrixSymbol,
  rosterCounts,
  ruleLabel,
  statusMeta,
  streakLabel,
  summaryLine,
} from "./attendanceModel";
import { AttendanceStatus } from "./AttendanceParts";
import { ClassList, CourseBreakdown, SummaryView } from "./AttendancePage";
import { FollowUpList, MatrixTable, RosterTable } from "./StaffAttendancePage";
import { attendanceShellRoutes } from "./routes";
import { ATTENDANCE_PING_MS, startAttendancePresence } from "./useAttendancePresence";

const render = (node) => renderToStaticMarkup(<StaticRouter location="/attendance">{node}</StaticRouter>);
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const SUMMARY = {
  rule: { present_min_minutes: 40, short_session_percent: 80, low_attendance_percent: 75, label: "Attended = 40+ minutes live", explanation: "Recordings do not count." },
  attended: 2,
  total: 3,
  partial: 1,
  absent: 0,
  excused: 1,
  percent: 66.7,
  low_attendance: true,
  streak: { current: 1, best: 2 },
  courses: [{ course: { id: 4, title: "OSINT Batch 7", batch: "B7" }, attended: 2, total: 3, partial: 1, absent: 0, excused: 1, percent: 66.7 }],
};

describe("attendance model", () => {
  it("names every status with an icon and a label (never colour alone)", () => {
    for (const status of ["present", "partial", "absent", "excused", "not_joined"]) {
      expect(statusMeta(status).label).toBeTruthy();
      expect(statusMeta(status).icon).toBeTruthy();
    }
    expect(statusMeta("present").label).toBe("Attended");
    expect(matrixSymbol("present")).toBe("●");
    expect(matrixSymbol(null)).toBe("·");
  });

  it("formats numbers for people", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(65)).toBe("1 h 05 min");
    expect(formatPercent(66.7)).toBe("66.7%");
    expect(formatPercent(100)).toBe("100%");
    expect(summaryLine({ attended: 7, total: 9 })).toBe("Attended 7 of 9 classes");
    expect(summaryLine({ attended: 0, total: 0 })).toBe("No finished classes yet");
    expect(streakLabel({ current: 1 })).toBe("1 class in a row");
    expect(ruleLabel({ present_min_minutes: 45 })).toBe("Attended = 45+ minutes live");
  });

  it("validates a correction before sending it", () => {
    expect(buildOverride({ userId: 3, status: "excused", reason: "  " }).error).toMatch(/reason/);
    expect(buildOverride({ userId: 3, status: "bogus", reason: "Medical" }).error).toMatch(/status/);
    expect(buildOverride({ userId: 3, status: "excused", reason: " Medical leave " }).body).toEqual({
      user_id: 3,
      status: "excused",
      reason: "Medical leave",
    });
  });

  it("counts and searches a roster", () => {
    const rows = [
      { user: { id: 1, name: "Asha", email: "a@x.in" }, status: "present", online: true },
      { user: { id: 2, name: "Bilal", email: "b@x.in" }, status: "not_joined" },
    ];
    expect(rosterCounts(rows)).toMatchObject({ present: 1, not_joined: 1, online: 1 });
    expect(filterRoster(rows, "bil").map((row) => row.user.id)).toEqual([2]);
  });

  it("recognises the switched-off answer", () => {
    const error = { response: { status: 403, data: { code: "feature_disabled", errors: { code: "feature_disabled", feature: "attendance" } } } };
    expect(isAttendanceDisabledError(error)).toBe(true);
    const teachingOff = { response: { status: 403, data: { code: "feature_disabled", errors: { code: "feature_disabled", feature: "teaching" } } } };
    expect(isAttendanceDisabledError(teachingOff)).toBe(false);
  });
});

describe("student page", () => {
  it("shows the summary with the 40-minute rule", () => {
    const html = text(render(<SummaryView summary={SUMMARY} />));
    expect(html).toContain("2 / 3");
    expect(html).toContain("66.7%");
    expect(html).toContain("Attended = 40+ minutes live");
    expect(html).toContain("below 75%");
  });

  it("lists classes with status, minutes and the recording link", () => {
    const html = render(
      <ClassList
        rows={[
          {
            id: 1,
            session_id: 9,
            date: "2026-11-13",
            starts_at: "2026-11-13T13:30:00+00:00",
            title: "Recon basics",
            course: { id: 4, title: "OSINT Batch 7" },
            status: "present",
            minutes_present: 45,
            on_air_minutes: 60,
            short_session: false,
            excused_reason: "",
            recording: { url: "/learn/4?lesson=12" },
          },
        ]}
      />
    );
    expect(html).toContain('data-attendance="present"');
    expect(html).toContain('href="/learn/4?lesson=12"');
    expect(text(html)).toContain("45 min of 1 h 00 min live");
  });

  it("explains an empty history and the per-batch bar", () => {
    expect(text(render(<ClassList rows={[]} />))).toContain("No finished live classes yet");
    expect(render(<CourseBreakdown courses={SUMMARY.courses} />)).toContain("width:66.7%");
  });

  it("renders the status chip as icon + label", () => {
    const html = render(<AttendanceStatus status="partial" />);
    expect(html).toContain("<svg");
    expect(text(html)).toContain("Partial");
  });
});

describe("staff reports", () => {
  it("renders a roster with live markers and corrections", () => {
    const html = text(
      render(
        <RosterTable
          data={{
            live: true,
            rows: [
              { user: { id: 1, name: "Asha", email: "a@x.in" }, status: "present", minutes_present: 41, online: true, manual_override: false },
              { user: { id: 2, name: "Bilal", email: "b@x.in" }, status: "excused", minutes_present: 0, manual_override: true, override_reason: "Medical" },
            ],
          }}
          onCorrect={() => {}}
        />
      )
    );
    expect(html).toContain("1 online now");
    expect(html).toContain("corrected: Medical");
  });

  it("renders the matrix with readable cells", () => {
    const html = render(
      <MatrixTable
        data={{
          course: { title: "OSINT" },
          sessions: [{ session_id: 1, date: "2026-11-13", title: "C1", short_session: true }],
          students: [{ user: { id: 1, name: "Asha" }, cells: ["present"], percent: 100 }],
        }}
      />
    );
    expect(html).toContain("●");
    expect(text(html)).toContain("Attended");
    expect(html).toContain(" *");
  });

  it("lists students to follow up", () => {
    const html = text(
      render(<FollowUpList data={{ threshold: 75, results: [{ user: { id: 1, name: "Asha", email: "a@x.in" }, course: { id: 4, title: "OSINT" }, attended: 1, total: 4, percent: 25 }] }} />)
    );
    expect(html).toContain("1/4 · 25%");
    expect(text(render(<FollowUpList data={{ threshold: 75, results: [] }} />))).toContain("at or above 75%");
  });
});

describe("presence loop", () => {
  function fakeWindow() {
    const listeners = {};
    return {
      timers: [],
      setInterval(fn) {
        this.timers.push(fn);
        return this.timers.length;
      },
      clearInterval() {
        this.timers = [];
      },
      addEventListener(name, fn) {
        listeners[name] = fn;
      },
      removeEventListener(name) {
        delete listeners[name];
      },
      fire(name) {
        listeners[name]?.();
      },
    };
  }

  it("pings at most once a minute while visible and leaves on stop", async () => {
    const win = fakeWindow();
    const doc = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
    let now = 0;
    const post = vi.fn(() => Promise.resolve());
    const leave = vi.fn(() => Promise.resolve());
    const stop = startAttendancePresence(7, { post, leave, win, doc, now: () => now });
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    win.timers[0]();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1); // too soon
    now = ATTENDANCE_PING_MS;
    win.timers[0]();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2);
    doc.visibilityState = "hidden";
    now = 3 * ATTENDANCE_PING_MS;
    win.timers[0]();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2); // hidden: no ping
    stop();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledWith(7);
  });

  it("does nothing without a session and leaves on pagehide once", async () => {
    expect(typeof startAttendancePresence(null)).toBe("function");
    const win = fakeWindow();
    const leave = vi.fn(() => Promise.resolve());
    const stop = startAttendancePresence(3, { post: () => Promise.resolve(), leave, win, doc: null });
    win.fire("pagehide");
    stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
  });
});

describe("registration", () => {
  it("exposes three routes", () => {
    expect(attendanceShellRoutes()).toHaveLength(3);
  });

  it("shows the nav items only while the attendance switch is on", () => {
    const student = { user: { role: "student" } };
    const off = getWorkspaceItems("learn", student, { caps: { features: {} } }).map((item) => item.id);
    expect(off).not.toContain("attendance");
    const on = getWorkspaceItems("learn", student, { caps: { features: { attendance: { enabled: true } } } }).map((item) => item.id);
    expect(on).toEqual(expect.arrayContaining(["attendance", "calendar"]));
    const staff = { isAdmin: true, user: { is_admin: true } };
    expect(buildShellNav(staff, { pathname: "/console/admin/attendance" }).activeItem?.id).toBe("admin-attendance");
  });
});
