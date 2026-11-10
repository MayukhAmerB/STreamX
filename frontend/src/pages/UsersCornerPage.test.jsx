import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { getCornerTileGroups } from "../features/app-shell/navConfig";
import { UsersCornerView } from "./UsersCornerPage";

const student = { user: { id: 7, full_name: "Asha Rao", role: "student" }, isInstructor: false, isAdmin: false };
const instructor = { user: { id: 8, full_name: "Imran Syed", role: "instructor" }, isInstructor: true, isAdmin: false };

const courses = [
  { id: 29, title: "OSINT Professional Training Program", category: "osint", lecture_count: 20, started_lecture_count: 8, completed_lecture_count: 6, progress_percent: 30 },
  { id: 31, title: "Web & API Penetration Testing", category: "web_pentesting", lecture_count: 24, progress_percent: 0 },
  { id: 12, title: "OSINT Foundations", category: "osint", lecture_count: 10, started_lecture_count: 10, completed_lecture_count: 10, progress_percent: 100 },
  { id: 40, title: "Fourth course", category: "osint", lecture_count: 4, progress_percent: 0 },
];

const now = new Date("2026-11-10T09:15:00Z");

const schedule = {
  days: ["Friday", "Saturday", "Sunday"],
  start_time: "19:00",
  end_time: "20:00",
  timezone: "Asia/Kolkata",
  timezone_label: "IST",
  next_start: "2026-11-13T13:30:00Z",
};

function render(props = {}, auth = student) {
  return renderToStaticMarkup(
    <StaticRouter location="/console">
      <UsersCornerView user={auth.user} tileGroups={getCornerTileGroups(auth)} schedule={schedule} now={now} {...props} />
    </StaticRouter>
  );
}

describe("UsersCornerView", () => {
  it("greets the user under the Console eyebrow with today's date and micro-stats", () => {
    const html = render({ courses });
    expect(html).toMatch(/<p class="uc-hub-hero__eyebrow"><span>Console<\/span>.*<time dateTime="2026-11-10">Tuesday 10 November<\/time><\/p>/);
    expect(html).toContain('<h1 id="uc-hub-title" class="uc-hub-hero__title">Welcome back, Asha</h1>');
    const stats = html.slice(html.indexOf('aria-label="Your progress"'));
    for (const [label, value] of [["Courses", "4"], ["In progress", "1"], ["Completed", "1"], ["Avg. progress", "33"]]) {
      expect(stats).toContain(`<dt class="cds-stat-chip__label">${label}</dt><dd class="cds-stat-chip__value">${value}`);
    }
    expect(stats).toContain('<span class="cds-stat-chip__suffix">%</span>');
  });

  it("resumes the last opened course in the Continue learning card", () => {
    const html = render({ courses, lastCourseId: "12" });
    const card = html.slice(html.indexOf("uc-card--continue"), html.indexOf("uc-courses-title"));
    expect(card).toContain("Continue learning");
    expect(card).toContain("OSINT Foundations");
    expect(card).toContain('href="/learn/12"');
    expect(card).toContain('aria-label="Review: OSINT Foundations"');
    expect(card).toContain("100% complete");
    expect(card).toContain('class="cds-meter cds-meter--done uc-card__progress"');
  });

  it("falls back to the course in progress when there is no last course", () => {
    const html = render({ courses });
    const card = html.slice(html.indexOf("uc-card--continue"), html.indexOf("uc-courses-title"));
    expect(card).toContain('href="/learn/29"');
    expect(card).toContain(">Continue<");
    expect(card).toContain("30% complete");
    expect(card).toContain("6 of 20 lessons done");
    expect(card).toMatch(/role="progressbar" aria-label="OSINT Professional Training Program progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="30"/);
  });

  it("previews three courses with artwork, progress and a link to all of them", () => {
    const html = render({ courses });
    const section = html.slice(html.indexOf('aria-labelledby="uc-courses-title"'));
    expect(section.match(/class="uc-course"/g)).toHaveLength(3);
    expect(section).not.toContain("Fourth course");
    expect(section).toMatch(/<a class="uc-section__link" href="\/my-courses">View all/);
    expect(section).toContain('href="/learn/31"');
    expect(section).toContain('<span class="uc-course__category">Web &amp; API pentesting</span>');
    expect(section).toContain('<span class="uc-art__shade"></span>');
  });

  it("shows Join class when a class is live, otherwise a countdown to the next class", () => {
    const live = { id: 9, title: "Dark web OSINT", status: "live", session_type: "meeting", host: { full_name: "Imran Syed" } };
    const liveHtml = render({ courses, liveSession: live });
    expect(liveHtml).toContain("Live now");
    expect(liveHtml).toContain("Dark web OSINT");
    expect(liveHtml).toContain("With Imran Syed · Meeting");
    expect(liveHtml).toMatch(/href="\/join-live\?session=9"[^>]*>.*Join class/);
    expect(liveHtml).toContain('class="uc-live-dot"');
    expect(liveHtml).not.toContain("Next live class");

    const nextHtml = render({ courses });
    expect(nextHtml).toContain("Next live class");
    // 2026-11-10 09:15Z -> 2026-11-13 13:30Z: 3 days 4 hours 15 minutes.
    expect(nextHtml).toContain('<span class="cds--visually-hidden">Starts in 3 days, 4 hours</span>');
    expect(nextHtml).toContain('<span class="uc-next__number">03</span><span class="uc-next__unit">d</span>');
    expect(nextHtml).toContain('<span class="uc-next__number">04</span><span class="uc-next__unit">h</span>');
    expect(nextHtml).toContain("Fri, 13 Nov · 7:00 PM IST");
    expect(nextHtml).toContain("Every week · Fri, Sat &amp; Sun · 7:00 – 8:00 PM IST");
    expect(nextHtml).toMatch(/href="\/join-live"[^>]*>.*Live classes/);
    expect(nextHtml).not.toContain("Live now");
  });

  it("shows shortcut tiles with an icon, label and hint, with Teaching only for staff", () => {
    const html = render({ courses });
    for (const [href, label, hint] of [
      ["/my-courses", "My courses", "Pick up where you left off"],
      ["/join-live", "Live classes", "Join and schedule classes"],
      ["/guides", "Guides", "Short how-to videos"],
      ["/osint-tools", "OSINT tools", "Your investigation toolkit"],
      ["/profile", "Profile", "Name, photo and password"],
      ["/id-card", "ID card", "Your student ID"],
    ]) {
      expect(html).toMatch(new RegExp(`<a class="uc-tile" aria-describedby="uc-tile-hint-[a-z-]+" href="${href}">`));
      expect(html).toContain(`<span class="uc-tile__label">${label}</span>`);
      expect(html).toContain(`>${hint}</span>`);
    }
    expect(html).toContain(">Shortcuts</h2>");
    expect(html).not.toContain("Teaching");

    const staff = render({ courses }, instructor);
    expect(staff).toContain("Welcome back, Imran");
    expect(staff).toContain(">Teaching</h2>");
    expect(staff).toContain('href="/instructor/dashboard"');
    expect(staff).toContain('href="/broadcasting"');
    expect(staff).not.toContain('href="/lecture-questions"');
  });

  it("opens Labs as an external tile in a new tab (Al syed only)", () => {
    const html = render({ courses });
    const tile = html.match(/<a href="https:\/\/labs\.alsyedinitiative\.com"[^>]*>.*?<\/a>/)?.[0] || "";
    expect(tile).toContain('target="_blank"');
    expect(tile).toContain('rel="noopener noreferrer"');
    expect(tile).toContain('class="uc-tile uc-tile--external"');
    expect(tile).toContain('<span class="uc-tile__label">Labs</span>');
    expect(tile).toContain("Practice OSINT challenges");
    expect(tile).toContain("(opens in a new tab)");

    const owl = renderToStaticMarkup(
      <StaticRouter location="/console">
        <UsersCornerView
          user={student.user}
          tileGroups={getCornerTileGroups(student, { brandId: "owlcognito" })}
          schedule={schedule}
          now={now}
        />
      </StaticRouter>
    );
    expect(owl).not.toContain("labs.alsyedinitiative.com");
  });

  it("handles loading, empty and error states with layout-shaped skeletons", () => {
    const loading = render({ coursesLoading: true, liveLoading: true });
    expect(loading).toContain("Loading your courses");
    expect(loading).toContain("Loading live classes");
    expect(loading).toContain("cds-stat-chip--skeleton");
    expect(loading.match(/uc-course uc-course--skeleton/g)).toHaveLength(3);
    expect(loading).not.toContain('aria-label="Your progress"');

    const empty = render({ courses: [] });
    expect(empty).toContain("Start your first course");
    expect(empty).toContain("Your purchased or approved courses will appear here.");
    expect(empty).toMatch(/href="\/courses"[^>]*>.*Browse courses/);
    expect(empty).not.toContain("View all");
    expect(empty).not.toContain("uc-courses-title");

    const failed = render({ coursesError: "Network down", onRetryCourses: () => {} });
    expect(failed).toContain("Couldn&#x27;t load your courses.");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain('aria-label="Your progress"');
  });
});
