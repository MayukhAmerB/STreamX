import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { resolveTheaterState } from "../../components/realtime/BroadcastViewerTheater";
import { clickFullscreenButton } from "../course-player/usePlayerShortcuts";
import { fire, renderTree } from "../../test-utils/renderTree";
import { LiveNowCard, LiveTrackTile, NextClassCard, SessionTile } from "./LiveCards";
import {
  countLiveSessions,
  filterLiveSessions,
  filterSessionsForCourse,
  sessionStatusLabel,
  sessionTypeLabel,
  shouldShowSessionFilter,
  sortLiveSessions,
} from "./liveSessions";
import {
  buildLiveScheduleIcs,
  formatNextClass,
  formatScheduleDays,
  formatScheduleSummary,
  formatScheduleTime,
  getNextClassStart,
} from "./schedule";

vi.mock("../app-shell/ui/toast", () => ({
  useToast: () => ({ showToast: () => 0, dismissToast: () => {} }),
  ToastProvider: ({ children }) => children,
}));

const sessions = [
  { id: 1, title: "Recon basics", status: "scheduled", session_type: "meeting", created_at: "2026-11-01T10:00:00Z", host: { full_name: "Imran Syed" } },
  { id: 2, title: "Dark web OSINT", status: "live", session_type: "broadcasting", created_at: "2026-10-01T10:00:00Z", linked_course: { id: 29 } },
  { id: 3, title: "Image verification", status: "scheduled", session_type: "broadcasting", created_at: "2026-11-05T10:00:00Z", linked_live_class: { id: 8, linked_course_id: 29 }, description: "Reverse image search" },
];

const schedule = {
  days: ["Friday", "Saturday", "Sunday"],
  start_time: "19:00",
  end_time: "20:00",
  timezone: "Asia/Kolkata",
  timezone_label: "IST",
  label: "Friday, Saturday and Sunday, 7:00 PM to 8:00 PM IST",
  next_start: "2026-11-13T13:30:00Z",
};

describe("live session list logic", () => {
  it("puts live sessions first, then the newest scheduled ones", () => {
    expect(sortLiveSessions(sessions).map((session) => session.id)).toEqual([2, 3, 1]);
  });

  it("scopes sessions to a course directly or through its live class", () => {
    expect(filterSessionsForCourse(sessions, 29).map((session) => session.id)).toEqual([2, 3]);
    expect(filterSessionsForCourse(sessions, null)).toHaveLength(3);
  });

  it("filters by type and searches title, description and host", () => {
    expect(filterLiveSessions(sessions, { mode: "broadcasting" }).map((s) => s.id)).toEqual([2, 3]);
    expect(filterLiveSessions(sessions, { query: "imran" }).map((s) => s.id)).toEqual([1]);
    expect(filterLiveSessions(sessions, { query: "reverse" }).map((s) => s.id)).toEqual([3]);
  });

  it("counts sessions and only offers the type filter when both types exist", () => {
    const counts = countLiveSessions(sessions);
    expect(counts).toEqual({ total: 3, live: 1, meeting: 1, broadcasting: 2 });
    expect(shouldShowSessionFilter(counts)).toBe(true);
    expect(shouldShowSessionFilter(countLiveSessions(sessions.slice(1)))).toBe(false);
    expect(sessionTypeLabel("broadcasting")).toBe("Broadcast");
    expect(sessionTypeLabel("meeting")).toBe("Meeting");
    expect(sessionStatusLabel("live")).toBe("Live");
    expect(sessionStatusLabel("")).toBe("Scheduled");
  });
});

describe("schedule labels and calendar file", () => {
  it("formats the weekly window compactly", () => {
    expect(formatScheduleDays(schedule)).toBe("Fri, Sat & Sun");
    expect(formatScheduleTime(schedule)).toBe("7:00 – 8:00 PM IST");
    expect(formatScheduleSummary(schedule)).toBe("Fri, Sat & Sun · 7:00 – 8:00 PM IST");
    expect(formatScheduleTime({ ...schedule, start_time: "11:30", end_time: "13:00" })).toBe("11:30 AM – 1:00 PM IST");
    expect(formatScheduleSummary(null)).toBe("Fri, Sat & Sun · 7:00 – 8:00 PM IST");
  });

  it("builds a recurring iCalendar event from the next class", () => {
    const ics = buildLiveScheduleIcs(schedule, {
      now: new Date("2026-11-10T12:00:00Z"),
      title: "Al syed live class",
      url: "https://example.com/join-live",
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART;TZID=Asia/Kolkata:20261113T190000");
    expect(ics).toContain("DTEND;TZID=Asia/Kolkata:20261113T200000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=FR,SA,SU");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("SUMMARY:Al syed live class");
    expect(ics).toContain("URL:https://example.com/join-live");
    expect(ics).toContain("DTSTAMP:20261110T120000Z");
  });

  it("finds the first class day itself when the server sends no next start", () => {
    // Tuesday 10 Nov 2026 -> the first class is Friday 13 Nov.
    const ics = buildLiveScheduleIcs({ ...schedule, next_start: null }, { now: new Date("2026-11-10T12:00:00Z") });
    expect(ics).toContain("DTSTART;TZID=Asia/Kolkata:20261113T190000");
  });

  it("says when the next class is in plain words", () => {
    const tuesday = new Date("2026-11-10T12:00:00Z");
    expect(formatNextClass(schedule, tuesday)).toBe("Fri, 13 Nov · 7:00 PM IST");
    // Thursday evening: the next class is tomorrow.
    expect(formatNextClass(schedule, new Date("2026-11-12T12:00:00Z"))).toBe("Tomorrow · 7:00 PM IST");
    // Friday afternoon before the class: today.
    expect(formatNextClass({ ...schedule, next_start: null }, new Date("2026-11-13T08:00:00Z"))).toBe("Today · 7:00 PM IST");
  });

  it("computes the next window itself when the server sends no next start", () => {
    const noServer = { ...schedule, next_start: null };
    // Friday 19:30 IST (class running): still today's class.
    expect(getNextClassStart(noServer, new Date("2026-11-13T14:00:00Z")).toISOString()).toBe("2026-11-13T13:30:00.000Z");
    // Friday 20:30 IST (class over): Saturday's class.
    expect(getNextClassStart(noServer, new Date("2026-11-13T15:00:00Z")).toISOString()).toBe("2026-11-14T13:30:00.000Z");
    // Sunday 21:00 IST: next Friday.
    expect(getNextClassStart(noServer, new Date("2026-11-15T15:30:00Z")).toISOString()).toBe("2026-11-20T13:30:00.000Z");
  });

  it("returns nothing for an unusable schedule", () => {
    expect(buildLiveScheduleIcs({ ...schedule, start_time: "" })).toBe("");
    expect(buildLiveScheduleIcs({ ...schedule, end_time: "18:00" })).toBe("");
  });
});

describe("live cards", () => {
  it("shows one big Join class button when a class is live", async () => {
    const onJoin = vi.fn();
    const view = await renderTree(<LiveNowCard session={sessions[1]} onJoin={onJoin} />);
    expect(view.text()).toContain("Live now");
    expect(view.text()).toContain("Dark web OSINT");
    await fire(view.getByLabel("button", "Join class"), "onClick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onJoin).toHaveBeenCalledWith(2);
  });

  it("swallows a rejected join so the page can show its own error", async () => {
    const onJoin = vi.fn(() => Promise.reject(new Error("nope")));
    const view = await renderTree(<LiveNowCard session={sessions[1]} onJoin={onJoin} />);
    await fire(view.getByLabel("button", "Join class"), "onClick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onJoin).toHaveBeenCalledTimes(1);
  });

  it("tells students when the next class is and offers Add to calendar", () => {
    const html = renderToStaticMarkup(<NextClassCard schedule={schedule} />);
    expect(html).toContain("No live class right now");
    expect(html).toContain("Next class");
    expect(html).toContain("Fri, Sat &amp; Sun · 7:00 – 8:00 PM IST");
    expect(html).toContain("Add to calendar");
  });

  it("shows Join only for joinable sessions", () => {
    const live = renderToStaticMarkup(<SessionTile session={sessions[1]} joinable highlighted scheduleSummary="Fri" />);
    expect(live).toContain("Join");
    expect(live).toContain("Shared link");
    const later = renderToStaticMarkup(<SessionTile session={sessions[0]} joinable={false} scheduleSummary="Fri, Sat &amp; Sun" />);
    expect(later).toContain("Not live yet");
    expect(later).toContain("With Imran Syed");
    expect(later).not.toContain("Join");
  });

  it("gives each live-class track one action for the student's access", () => {
    const track = { id: 8, title: "OSINT Month 1", level: "beginner", class_duration_minutes: 60, enrollment_count: 12, linked_course_id: 29, linked_course_title: "OSINT Beginner" };
    const render = (props) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <LiveTrackTile track={track} monthLabel="Month 1" scheduleSummary="Fri" nextClassLabel="Friday 13 Nov" priceLabel="Free" {...props} />
        </MemoryRouter>
      );
    expect(render({ hasApprovedAccess: true, liveSession: { id: 4 } })).toContain("Join class");
    expect(render({ hasApprovedAccess: true })).toContain("Next class: Friday 13 Nov");
    expect(render({ hasApprovedAccess: false })).toContain("View course");
    expect(render({ hasApprovedAccess: false, track: { ...track, enrollment_status: "pending" } })).toContain("Request pending");
    expect(render({ hasApprovedAccess: false, track: { ...track, linked_course_id: null } })).toContain("Enrollment required");
    expect(render({ hasApprovedAccess: true })).toContain("Included with OSINT Beginner");
  });
});

describe("broadcast theater status", () => {
  it("maps stream and session status to the live tag", () => {
    expect(resolveTheaterState({ streamStatus: "live", sessionStatus: "live" })).toBe("live");
    expect(resolveTheaterState({ streamStatus: "", sessionStatus: "live" })).toBe("live");
    expect(resolveTheaterState({ streamStatus: "starting", sessionStatus: "live" })).toBe("starting");
    expect(resolveTheaterState({ streamStatus: "offline", sessionStatus: "live" })).toBe("offline");
    expect(resolveTheaterState({ streamStatus: "live", sessionStatus: "ended" })).toBe("ended");
  });
});

describe("course player F shortcut", () => {
  it("clicks the marked fullscreen icon button", () => {
    const click = vi.fn();
    const container = {
      querySelector: (selector) => (selector.includes("data-playback-action='fullscreen'") ? { click } : null),
      querySelectorAll: () => [],
    };
    clickFullscreenButton(container);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("falls back to a button labelled Fullscreen", () => {
    const click = vi.fn();
    const container = {
      querySelector: () => null,
      querySelectorAll: () => [
        { textContent: "", getAttribute: () => "Mute", click: vi.fn() },
        { textContent: "", getAttribute: () => "Exit fullscreen", click },
      ],
    };
    clickFullscreenButton(container);
    expect(click).toHaveBeenCalledTimes(1);
  });
});
