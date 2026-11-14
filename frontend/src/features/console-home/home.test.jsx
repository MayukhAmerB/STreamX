// Console Home ("Next up") and Teach > Today (plan §3.4/§3.5). OWNER: WS-C.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import today from "../../__contracts__/ui-overhaul/today.json";
import { TeachTodayView } from "../teach-today/TeachTodayPage";
import HomeView, { HomeStats, NextUpCard, PracticeCards, nextClassLabel } from "./HomeView";
import { practiceFromCaps } from "./HomePage";
import { buildTeachRows, formatAlsoMeta, formatWhen, getStartsIn, isAllCaughtUp, isExternalHref } from "./homeModel";

const now = new Date("2026-11-14T06:30:00Z"); // Sat 14 Nov, 12:00 IST
const user = { id: 7, full_name: "Sana Student" };

const render = (node) => renderToStaticMarkup(<StaticRouter location="/console">{node}</StaticRouter>);
const countMatches = (html, pattern) => (html.match(pattern) || []).length;
const textOf = (html) => html.replace(/<[^>]+>/g, "");

function nextUp(kind, overrides = {}) {
  return { ...today.learn.next_up, kind, image: null, progress: null, starts_at: null, due_at: null, ...overrides };
}

describe("homeModel", () => {
  it("formats times in IST relative to today", () => {
    expect(formatWhen("2026-11-14T13:30:00Z", now)).toBe("Today 7:00 pm");
    expect(formatWhen("2026-11-15T18:29:00Z", now)).toBe("Tomorrow 11:59 pm");
    expect(formatWhen("2026-11-20T13:30:00Z", now)).toBe("Fri 20 Nov, 7:00 pm");
    expect(formatWhen("not a date", now)).toBe("");
  });

  it("labels also-rows by kind", () => {
    expect(formatAlsoMeta({ kind: "report_due", due_at: "2026-11-15T18:29:00Z" }, now)).toBe("Due Tomorrow 11:59 pm");
    expect(formatAlsoMeta({ kind: "exam_open", due_at: "2026-11-14T13:30:00Z" }, now)).toBe("Closes Today 7:00 pm");
    expect(formatAlsoMeta({ kind: "resume", due_at: null }, now)).toBe("");
  });

  it("counts down to a future class only", () => {
    expect(getStartsIn("2026-11-14T10:58:00Z", now).segments).toEqual([
      { value: "04", unit: "h" },
      { value: "28", unit: "m" },
    ]);
    expect(getStartsIn("2026-11-16T13:30:00Z", now).segments[0]).toEqual({ value: "2", unit: "d" });
    expect(getStartsIn("2026-11-13T13:30:00Z", now)).toBeNull();
  });

  it("knows labs links are external", () => {
    expect(isExternalHref("https://labs.example.com/#exam")).toBe(true);
    expect(isExternalHref("/reports")).toBe(false);
  });
});

describe("NextUpCard", () => {
  it("live now: red Live tag and the champagne Join live", () => {
    const html = render(<NextUpCard item={today.learn.next_up} now={now} />);
    expect(html).toContain('data-kind="live_now"');
    expect(html).toContain("Live now");
    expect(html).toContain('href="/courses/12/live"');
    expect(countMatches(html, /ch-accent-button/g)).toBe(1);
  });

  it("exam open: Start opens labs in a new tab", () => {
    const html = render(<NextUpCard item={nextUp("exam_open", { title: "E2E OSINT examination", action: { label: "Start exam", href: "https://labs.example.com/#exam" } })} now={now} />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Start exam");
    expect(html).toContain("(opens in a new tab)");
  });

  it("resume: progress meter with the percent", () => {
    const html = render(<NextUpCard item={nextUp("resume", { title: "OSINT Foundations", progress: 0.4, action: { label: "Resume", href: "/learn/12" } })} now={now} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("40% complete");
    expect(html).toContain('href="/learn/12"');
  });

  it("next class: countdown and Add to calendar, nothing else champagne", () => {
    const html = render(<NextUpCard item={nextUp("next_class", { title: "Next live class", starts_at: "2026-11-14T13:30:00Z", action: { label: "Live classes", href: "/join-live" } })} now={now} />);
    expect(html).toContain("Starts in 7 hours 0 minutes");
    expect(html).toContain("Add to calendar");
    expect(html).toContain('href="/join-live"');
    expect(countMatches(html, /ch-accent-button/g)).toBe(1);
  });

  it("browse: the catalogue and a way to ask for a code, no countdown", () => {
    const html = render(<NextUpCard item={today.learn_browse.next_up} now={now} />);
    expect(html).toContain("You&#x27;re not enrolled yet");
    expect(html).toContain('href="/courses"');
    expect(html).toContain('href="/contact"');
    expect(html).not.toContain("Starts in");
  });
});

describe("HomeView", () => {
  it("greets, then Next up, Also this week and Your courses", () => {
    const html = render(<HomeView user={user} data={today.learn} now={now} />);
    expect(textOf(html)).toContain("Welcome back, Sana.");
    // The first name is the one handwritten word of the headline.
    expect(html).toMatch(/<span class="ch-hand">Sana<\/span>/);
    expect(html).toContain("Saturday 14 November");
    expect(html.indexOf("ch-next ")).toBeLessThan(html.indexOf("Also this week"));
    expect(html.indexOf("Also this week")).toBeLessThan(html.indexOf("Your courses"));
    expect(html).toContain("Week of 9–15 Nov");
    expect(html).toContain('href="/my-courses"');
    // One champagne action per screen; no stat chips, no shortcut tiles.
    expect(countMatches(html, /ch-accent-button/g)).toBe(1);
    expect(html).not.toContain("uc-tile");
    expect(html).not.toContain("cds-stat-chip");
  });

  it("no-course user: one card, no also-rows, no courses", () => {
    const html = render(<HomeView user={user} data={today.learn_browse} now={now} />);
    expect(html).not.toContain("Also this week");
    expect(html).not.toContain("Your courses");
  });

  it("loading shows the skeleton only once it is due; errors offer Retry", () => {
    expect(render(<HomeView user={user} loading now={now} />)).not.toContain("ch-skeleton");
    expect(render(<HomeView user={user} loading showSkeleton now={now} />)).toContain("ch-skeleton");
    expect(render(<HomeView user={user} error="Offline" onRetry={() => {}} now={now} />)).toContain("Try again");
  });
});

describe("Home: HackPath stat strip and practice cards", () => {
  const engagement = {
    xp: 1295,
    level: { number: 3, title: "Operator" },
    streak: { current: 3, alive: true },
    time: { this_week_seconds: 2700 },
  };

  it("stat strip: streak, XP with the rank, study time and the next class (engagement only)", () => {
    const html = render(<HomeStats engagement={engagement} data={today.learn} now={now} />);
    const words = textOf(html);
    expect(words).toContain("Streak");
    expect(words).toContain("3days");
    expect(words).toContain("1,295XP");
    expect(words).toContain("Operator");
    expect(words).toContain("45 min");
    expect(render(<HomeStats engagement={null} data={today.learn} now={now} />)).toBe("");
    expect(render(<HomeView user={user} data={today.learn} now={now} />)).not.toContain("eg-stats");
    expect(render(<HomeView user={user} data={today.learn} now={now} engagement={engagement} />)).toContain("eg-stats");
  });

  it("next class label comes from Next up or the also-rows", () => {
    expect(nextClassLabel(null)).toBe("");
    expect(nextClassLabel({ next_up: { kind: "live_now" } })).toBe("Live now");
    expect(nextClassLabel({ next_up: { kind: "resume" }, also: [{ kind: "next_class", due_at: "2026-11-14T13:30:00Z" }] }, now)).toBe("Today 7:00 pm");
  });

  it("labs card: open now (labs switch off) or members (switch on); pentesting card is browsable, coming soon", () => {
    const open = render(<PracticeCards labsMembersOnly={false} pentestingOpen={false} />);
    expect(open).toContain('href="https://labs.alsyedinitiative.com"');
    expect(open).toContain('target="_blank"');
    expect(textOf(open)).toContain("Open now");
    expect(open).toContain('href="/tracks/pentesting"');
    expect(textOf(open)).toContain("Coming soon");
    expect(textOf(open)).toContain("enrolment opens at launch");
    const members = render(<PracticeCards labsMembersOnly pentestingOpen />);
    expect(textOf(members)).toContain("Members");
    expect(textOf(members)).not.toContain("Coming soon");
    expect(render(<PracticeCards brandId="owlcognito" />)).toBe("");
  });

  it("free tier card links to the free OSINT directory, never to the labs", () => {
    const html = render(<PracticeCards />);
    expect(html).toContain('href="/osint/free"');
    expect(html).toContain('data-testid="home-free-directory-card"');
    expect(textOf(html)).toContain("Free OSINT challenges");
    // The members-only labs card is never labelled Free once membership is required.
    const members = render(<PracticeCards labsMembersOnly />);
    expect(members.match(/data-testid="home-labs-card"[^]*?<\/a>/)[0]).not.toMatch(/>Free</);
  });

  it("reads the practice flags from capabilities (disable, never hide)", () => {
    expect(practiceFromCaps(null, "alsyed")).toEqual({ brandId: "alsyed", labsMembersOnly: false, pentestingOpen: false });
    expect(practiceFromCaps({ items: { "pentesting-purchase": { state: "disabled", reason: "Soon" } } }, "alsyed").pentestingOpen).toBe(false);
    expect(practiceFromCaps({ items: { "pentesting-purchase": { state: "enabled" } } }, "alsyed").pentestingOpen).toBe(true);
    expect(practiceFromCaps({ features: { labs_membership_required: { enabled: true } } }, "alsyed").labsMembersOnly).toBe(true);
  });

  it("still one golden action with the practice band present", () => {
    const html = render(<HomeView user={user} data={today.learn} now={now} practice={{ brandId: "alsyed" }} />);
    expect(countMatches(html, /ch-accent-button/g)).toBe(1);
    expect(html.indexOf("Your courses")).toBeLessThan(html.indexOf("Practice"));
  });
});

describe("Teach > Today", () => {
  it("builds one row per job with the first waiting job in champagne", () => {
    const rows = buildTeachRows(today.teach.teach, now);
    expect(rows.map((row) => row.key)).toEqual(["to_grade", "host_next", "recordings", "exams_open"]);
    expect(rows[0].text).toBe("12 reports waiting, oldest 3 days");
    expect(rows.filter((row) => row.accent).map((row) => row.key)).toEqual(["to_grade"]);
    expect(rows[1].text).toBe("Fri 20 Nov, 7:00 pm");
    expect(rows[2].text).toBe("1 processing, 1 to publish");
    expect(rows[3].text).toBe("1 exam open · 23/40 submitted");
    expect(isAllCaughtUp(rows)).toBe(false);
  });

  it("all caught up when nothing waits", () => {
    const quiet = {
      to_grade: { count: 0, oldest_at: null, href: "/console/teach/grading" },
      host_next: { session_id: null, starts_at: null, href: "/console/teach/classes" },
      recordings: { processing: 0, to_publish: 0, href: "/console/teach/recordings" },
      exams_open: { count: 0, submitted: 0, eligible: 0, href: "/console/teach/exams" },
    };
    const html = render(<TeachTodayView teach={quiet} now={now} />);
    expect(html).toContain("All caught up");
    expect(html).not.toContain("ch-accent-button");
    expect(html).toContain("No class scheduled");
  });

  it("renders the counts and actions", () => {
    const html = render(<TeachTodayView teach={today.teach.teach} now={now} />);
    expect(html).toContain("<h1");
    expect(html).toContain("Open queue");
    expect(html).toContain('href="/console/teach/classes/5/studio"');
    expect(countMatches(html, /ch-accent-button/g)).toBe(1);
  });

  it("switched off: the off page, never a redirect", () => {
    const html = render(<TeachTodayView errorCode="feature_disabled" error="Teaching tools are switched off for now." now={now} />);
    expect(html).toContain("Teaching is switched off");
  });
});
