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

const schedule = {
  days: ["Friday", "Saturday", "Sunday"],
  start_time: "19:00",
  end_time: "20:00",
  timezone: "Asia/Kolkata",
  timezone_label: "IST",
};

function render(props = {}, auth = student) {
  return renderToStaticMarkup(
    <StaticRouter location="/users-corner">
      <UsersCornerView user={auth.user} tileGroups={getCornerTileGroups(auth)} schedule={schedule} {...props} />
    </StaticRouter>
  );
}

describe("UsersCornerView", () => {
  it("greets the user by first name under the Overview eyebrow", () => {
    const html = render({ courses });
    expect(html).toContain('<p class="uc-hub-hero__eyebrow" aria-hidden="true">Overview</p>');
    expect(html).toContain('<h1 id="uc-hub-title" class="uc-hub-hero__title">Welcome back, Asha</h1>');
    expect(html).toContain("<li>4 courses</li>");
    expect(html).toContain("<li>1 in progress</li>");
    expect(html).toContain("<li>1 completed</li>");
  });

  it("resumes the last opened course in the Continue learning card", () => {
    const html = render({ courses, lastCourseId: "12" });
    const card = html.slice(html.indexOf("uc-card--continue"), html.indexOf("uc-card--live"));
    expect(card).toContain("Continue learning");
    expect(card).toContain("OSINT Foundations");
    expect(card).toContain('href="/learn/12"');
    expect(card).toContain('aria-label="Review: OSINT Foundations"');
    expect(card).toContain("100% complete");
  });

  it("falls back to the course in progress when there is no last course", () => {
    const html = render({ courses });
    const card = html.slice(html.indexOf("uc-card--continue"), html.indexOf("uc-card--live"));
    expect(card).toContain('href="/learn/29"');
    expect(card).toContain(">Continue<");
    expect(card).toContain("30% complete");
  });

  it("previews three courses with progress and links to all of them", () => {
    const html = render({ courses });
    const section = html.slice(html.indexOf('aria-labelledby="uc-courses-title"'));
    expect(section.match(/class="uc-course"/g)).toHaveLength(3);
    expect(section).not.toContain("Fourth course");
    expect(section).toMatch(/<a class="uc-section__link" href="\/my-courses">View all/);
    expect(section).toContain('href="/learn/31"');
  });

  it("shows Join class when a class is live, otherwise the next class", () => {
    const live = { id: 9, title: "Dark web OSINT", status: "live", session_type: "meeting", host: { full_name: "Imran Syed" } };
    const liveHtml = render({ courses, liveSession: live });
    expect(liveHtml).toContain("Live now");
    expect(liveHtml).toContain("Dark web OSINT");
    expect(liveHtml).toContain("With Imran Syed · Meeting");
    expect(liveHtml).toMatch(/href="\/join-live\?session=9"[^>]*>.*Join class/);
    expect(liveHtml).toContain('class="uc-live-dot"');

    const nextHtml = render({ courses });
    expect(nextHtml).toContain("Next live class");
    expect(nextHtml).toContain("Every week · Fri, Sat &amp; Sun · 7:00 – 8:00 PM IST");
    expect(nextHtml).toMatch(/href="\/join-live"[^>]*>.*Live classes/);
    expect(nextHtml).not.toContain("Live now");
  });

  it("shows big tiles for every destination, with Teaching only for staff", () => {
    const html = render({ courses });
    for (const [href, label, name] of [
      ["/my-courses", "Courses", "My courses"],
      ["/join-live", "Live", "Live classes"],
      ["/guides", "Guides", "Guides"],
      ["/osint-tools", "Tools", "OSINT tools"],
      ["/profile", "Profile", "Profile"],
      ["/id-card", "ID card", "ID card"],
    ]) {
      expect(html).toContain(`<a class="uc-tile" aria-label="${name}" href="${href}">`);
      expect(html).toContain(`<span class="uc-tile__label">${label}</span>`);
    }
    expect(html).not.toContain("Teaching");

    const staff = render({ courses }, instructor);
    expect(staff).toContain("Welcome back, Imran");
    expect(staff).toContain(">Teaching</h2>");
    expect(staff).toContain('href="/instructor/dashboard"');
    expect(staff).toContain('href="/broadcasting"');
    expect(staff).not.toContain('href="/lecture-questions"');
  });

  it("handles loading, empty and error states", () => {
    const loading = render({ coursesLoading: true, liveLoading: true });
    expect(loading).toContain("Loading your courses");
    expect(loading).toContain("Loading live classes");
    expect(loading).not.toContain("uc-hub-hero__stats");

    const empty = render({ courses: [] });
    expect(empty).toContain("Start your first course");
    expect(empty).toContain("Your purchased or approved courses will appear here.");
    expect(empty).not.toContain("View all");

    const failed = render({ coursesError: "Network down", onRetryCourses: () => {} });
    expect(failed).toContain("Couldn&#x27;t load your courses.");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("uc-hub-hero__stats");
  });
});
