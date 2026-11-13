import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, renderTree, textOf } from "../../test-utils/renderTree";
import BestsellersBand, { courseStatusTag } from "./BestsellersBand";
import HeroBand, { HeroCountdownStrip, TrackTiles } from "./HeroBand";
import { assignBandThemes } from "./LandingPageV2";
import LiveClassesBand, { formatLiveClassPrice, liveClassAction } from "./LiveClassesBand";
import { isLandingV2Enabled } from "./landingFlag";
import { isLiveClassOnAir, liveBroadcastJoinPath, selectFeaturedCoursePath, selectHeroLiveBroadcast } from "./useLandingData";

const html = (element) => renderToStaticMarkup(<StaticRouter location="/">{element}</StaticRouter>);

const COURSES = [
  { id: 101, title: "OSINT Professional Program", category: "osint", level: "beginner", launch_status: "live", is_published: true, created_at: "2026-01-05T10:00:00Z", review_count: 12, average_rating: 4.8 },
  { id: 202, title: "Web Application Pentesting Advanced", category: "web_pentesting", launch_status: "coming_soon", is_published: true, created_at: "2026-04-05T10:00:00Z" },
];
const OPEN = { key: "osint", title: "Open Source Intelligence", state: "open", courseCount: 1, openCourseCount: 1 };
const SOON = { key: "web_pentesting", title: "Web Application & API Security", state: "coming_soon", courseCount: 1, openCourseCount: 0 };

const catalog = (overrides = {}) => ({ courses: COURSES, tracks: [OPEN, SOON], status: "ready", updatedAt: Date.parse("2026-11-13T10:15:00Z"), fromCache: false, retry: () => {}, ...overrides });
const liveState = (overrides = {}) => ({ items: [], status: "ready", updatedAt: null, retry: () => {}, ...overrides });

describe("landing v2: flag and band rhythm", () => {
  it("is on by default and off only when VITE_LANDING_V2 says so", () => {
    expect(isLandingV2Enabled(undefined)).toBe(true);
    expect(isLandingV2Enabled("on")).toBe(true);
    for (const off of ["off", "OFF", "false", "0", "no"]) expect(isLandingV2Enabled(off)).toBe(false);
  });

  const ALL_BANDS = ["hero", "bestsellers", "watch", "live", "certificate", "about", "story", "why", "journey", "cta"];
  const PLAN_THEMES = {
    hero: "g100",
    bestsellers: "white",
    watch: "g100",
    live: "g10",
    certificate: "g100",
    about: "white",
    story: "g100",
    why: "g10",
    journey: "g100",
    cta: "white",
  };

  it("assigns the plan §7.3 theme to each band by content", () => {
    expect(assignBandThemes(ALL_BANDS)).toEqual(PLAN_THEMES);
  });

  it("keeps the tallest blocks light when the Watch band is absent (OwlCognito)", () => {
    const noWatch = assignBandThemes(ALL_BANDS.filter((key) => key !== "watch"));
    expect(noWatch).toEqual(Object.fromEntries(Object.entries(PLAN_THEMES).filter(([key]) => key !== "watch")));
    // Programs, live classes and About (with its stats) never go dark.
    for (const key of ["bestsellers", "live", "about"]) expect(noWatch[key]).not.toBe("g100");
  });

  it("never puts the final CTA on a dark band, so it never merges into the dark footer", () => {
    for (const keys of [ALL_BANDS, ALL_BANDS.filter((key) => key !== "watch")]) {
      expect(assignBandThemes(keys).cta).not.toBe("g100");
    }
  });

  it("never stacks two dark bands, with or without the Watch band", () => {
    for (const keys of [ALL_BANDS, ALL_BANDS.filter((key) => key !== "watch")]) {
      const themes = keys.map((key) => assignBandThemes(keys)[key]);
      themes.slice(1).forEach((theme, index) => {
        expect(theme === "g100" && themes[index] === "g100").toBe(false);
      });
    }
  });
});

describe("landing v2: hero", () => {
  it("renders the disabled Pentesting tile from tracks[] (no href, no arrow, focusable, with its reason)", () => {
    const markup = html(<TrackTiles courses={COURSES} tracks={[OPEN, SOON]} />);
    expect(markup).toContain('href="/courses?category=osint#course-category-results"');
    expect(markup).not.toContain("category=web_pentesting");
    expect(markup).toMatch(/<div role="link" aria-disabled="true" tabindex="0" class="sk-tile sk-tile--clickable is-disabled lp-track"/);
    expect(markup).toContain("Coming soon · No courses yet");
    // Only the open track invites a click.
    expect(markup.match(/View all courses/g)).toHaveLength(1);
  });

  it("keeps both tiles as links when the server sent no tracks (never guesses closed)", () => {
    const markup = html(<TrackTiles courses={COURSES} tracks={[]} />);
    expect(markup).toContain("category=osint");
    expect(markup).toContain("category=web_pentesting");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("shows Get Started for guests, Console for members, and the live notice only when on air", () => {
    const guest = html(<HeroBand isAuthenticated={false} liveBroadcast={null} courses={COURSES} tracks={[OPEN, SOON]} />);
    expect(guest).toContain("Learn practical");
    expect(guest).toContain('href="/login"');
    expect(guest).toContain("Get Started");
    expect(guest).not.toContain("Class is live");
    expect(guest).toContain("2 professional tracks");
    const member = html(
      <HeroBand
        isAuthenticated
        liveBroadcast={{ id: 55, title: "Sunday OSINT live", linked_course: { id: 101 } }}
        courses={COURSES}
        tracks={[OPEN, SOON]}
      />
    );
    expect(member).toContain('href="/console"');
    expect(member).toContain("Class is live");
    expect(member).toContain('data-status="live"');
    expect(member).toContain('href="/courses/101/live?session=55"');
  });

  it("counts down per minute, adds seconds only in the last hour, and can be paused", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-13T12:00:00Z") });
    try {
      const far = [{ id: 1, title: "OSINT", hero_countdown_end_at: "2026-11-15T14:30:00Z", hero_countdown_label: "Enrollment closes in" }];
      const farMarkup = html(<HeroCountdownStrip courses={far} />);
      expect(farMarkup).toContain("Enrollment closes in");
      expect(farMarkup).toContain('data-units="3"');
      expect(farMarkup).not.toContain("Seconds");
      const near = [{ id: 1, title: "OSINT", hero_countdown_end_at: "2026-11-13T12:40:00Z" }];
      expect(html(<HeroCountdownStrip courses={near} />)).toContain("Seconds");

      vi.stubGlobal("window", { setTimeout: () => 1, clearTimeout: () => {} });
      const tree = await renderTree(<HeroCountdownStrip courses={far} />);
      const pause = tree.find((node) => node.type === "button");
      expect(textOf(pause)).toBe("Pause countdown");
      await act(async () => pause.props.onClick());
      expect(textOf(tree.find((node) => node.type === "button"))).toBe("Resume countdown");
      expect(tree.find((node) => node.type === "button").props["aria-pressed"]).toBe(true);
      await tree.unmount();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("landing v2: bestsellers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the status vocabulary: Open, Coming soon, Previous batch (never Live)", () => {
    expect(courseStatusTag({ launch_status: "live" })).toBe("open");
    expect(courseStatusTag({ launch_status: "coming_soon" })).toBe("coming-soon");
    expect(courseStatusTag({ launch_status: "live", registration_closed: true })).toBe("previous-batch");
  });

  it("renders one primary link per card plus the reviews link, in a labelled carousel", () => {
    const markup = html(<BestsellersBand catalog={catalog()} />);
    expect(markup).toContain('aria-roledescription="carousel"');
    expect(markup).toContain('aria-label="Scroll courses backward"');
    expect(markup).toContain("Oldest programs first");
    expect(markup.match(/href="\/courses\/101"/g)).toHaveLength(1);
    expect(markup).toContain('href="/courses/101#reviews"');
    expect(markup).toContain("4.8");
    expect(markup).toContain("See Details");
  });

  it("disables every card of a track that has not opened (no links, focusable, with its reason)", () => {
    const markup = html(<BestsellersBand catalog={catalog()} />);
    expect(markup).not.toContain('href="/courses/202"');
    expect(markup).not.toContain('href="/courses/202#reviews"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("Coming soon · No courses yet");
    // With no tracks from the server, nothing is guessed closed.
    const unknown = html(<BestsellersBand catalog={catalog({ tracks: [] })} />);
    expect(unknown).toContain('href="/courses/202"');
  });

  it("offers the enquiry form when no course is listed (no invented course)", () => {
    const markup = html(<BestsellersBand catalog={catalog({ courses: [] })} />);
    expect(markup).toContain("Live courses are being updated.");
    expect(markup).toContain("Submit an enrollment enquiry and our team will contact you.");
    expect(markup).toMatch(/<button type="button" class="sk-button sk-button--primary sk-button--md"><span class="sk-button__label">Submit an enquiry<\/span><\/button>/);
    expect(markup).not.toContain("aria-roledescription");
  });

  it("shows an error with Retry when the catalogue fails with nothing cached, and keeps cached data with Last updated", () => {
    const failed = html(<BestsellersBand catalog={catalog({ courses: [], status: "error" })} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Courses could not be loaded.");
    expect(failed).toContain(">Retry<");
    expect(failed).not.toContain("Submit an enquiry");
    const cached = html(<BestsellersBand catalog={catalog({ status: "error" })} />);
    expect(cached).toContain("Showing the last saved course list.");
    expect(cached).toContain("Last updated");
    expect(cached).toContain('href="/courses/101"');
  });

  it("pages the carousel with the arrow keys", async () => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {}, matchMedia: () => ({ matches: false }) });
    const tree = await renderTree(
      <MemoryRouter>
        <BestsellersBand catalog={catalog()} />
      </MemoryRouter>
    );
    const track = tree.find((node) => node.props?.["aria-roledescription"] === "carousel");
    track.scrollBy = vi.fn();
    track.clientWidth = 800;
    const event = (key) => ({ key, target: track, currentTarget: track, preventDefault: vi.fn() });
    track.props.onKeyDown(event("ArrowRight"));
    track.props.onKeyDown(event("ArrowLeft"));
    expect(track.scrollBy).toHaveBeenNthCalledWith(1, { left: 800, behavior: "smooth" });
    expect(track.scrollBy).toHaveBeenNthCalledWith(2, { left: -800, behavior: "smooth" });
    await tree.unmount();
  });
});

describe("landing v2: live classes", () => {
  const CLASSES = [
    { id: 11, title: "OSINT Month 1", schedule_days: "Friday, Saturday, Sunday", linked_course_id: 101, linked_course_title: "OSINT Professional Program", is_enrolled: true, enrollment_status: "approved" },
    { id: 14, title: "OSINT Standalone", schedule_days: "Sunday", price: 0, enrollment_status: "none" },
  ];

  it("keeps the four action states, each with a reason", () => {
    expect(liveClassAction({ is_enrolled: true, linked_course_id: 5 })).toMatchObject({ label: "Open live class", href: "/courses/5/live" });
    expect(liveClassAction({ enrollment_status: "approved" })).toMatchObject({ href: "/courses?view=owned" });
    expect(liveClassAction({ enrollment_status: "pending" })).toMatchObject({ label: "Request pending", disabled: true });
    expect(liveClassAction({ linked_course_id: 7 })).toMatchObject({ label: "View the course", href: "/courses/7" });
    expect(liveClassAction({})).toMatchObject({ label: "Enrollment closed", disabled: true });
    for (const state of [{ is_enrolled: true }, { enrollment_status: "pending" }, { linked_course_id: 7 }, {}]) {
      expect(liveClassAction(state).reason).toMatch(/\w/);
    }
  });

  it("never calls an unpriced class Free", () => {
    expect(formatLiveClassPrice(0)).toBe("On request");
    expect(formatLiveClassPrice(null)).toBe("On request");
  });

  it("shows an honest empty state with one real action (no fabricated classes)", () => {
    const markup = html(<LiveClassesBand liveClasses={liveState()} liveBroadcast={null} />);
    expect(markup).toContain("No live classes scheduled right now");
    expect(markup).toContain('href="/courses"');
    expect(markup).not.toMatch(/Month 1|₹/);
  });

  it("shows the red Live tag only for the class that is on air", () => {
    const offAir = html(<LiveClassesBand liveClasses={liveState({ items: CLASSES })} liveBroadcast={null} />);
    expect(offAir).not.toContain('data-status="live"');
    expect(offAir).toContain(">Live class<");
    expect(offAir).not.toContain("Live class · ");
    expect(offAir).toContain("Fri, Sat, Sun"); // in the Schedule fact
    expect(offAir).not.toContain("lp-class__sep");
    const onAir = html(<LiveClassesBand liveClasses={liveState({ items: CLASSES })} liveBroadcast={{ id: 55, linked_course: { id: 101 } }} />);
    expect(onAir.match(/data-status="live"/g)).toHaveLength(1);
    expect(isLiveClassOnAir(CLASSES[1], { id: 55, linked_course: { id: 101 } })).toBe(false);
  });

  it("reports a failed feed with Retry, keeping the last real list", () => {
    const failed = html(<LiveClassesBand liveClasses={liveState({ status: "error" })} liveBroadcast={null} />);
    expect(failed).toContain("Live classes could not be loaded.");
    expect(failed).toContain(">Retry<");
    expect(failed).not.toContain("No live classes scheduled");
    const kept = html(<LiveClassesBand liveClasses={liveState({ status: "error", items: CLASSES, updatedAt: Date.now() })} liveBroadcast={null} />);
    expect(kept).toContain("Showing the last live class list.");
    expect(kept).toContain("OSINT Month 1");
    expect(kept).toContain("Last updated");
  });
});

describe("landing data helpers", () => {
  it("joins the newest on-air broadcast through its course, else /join-live", () => {
    const live = selectHeroLiveBroadcast([
      { id: 1, session_type: "broadcasting", status: "ended", stream_status: "live" },
      { id: 2, session_type: "broadcasting", status: "live", stream_status: "idle" },
      { id: 3, session_type: "broadcasting", status: "live", stream_status: "live", started_at: "2026-11-13T10:00:00Z" },
    ]);
    expect(live.id).toBe(3);
    expect(liveBroadcastJoinPath(live)).toBe("/join-live?session=3");
    expect(liveBroadcastJoinPath({ id: 4, linked_course: { id: 9 } })).toBe("/courses/9/live?session=4");
    expect(liveBroadcastJoinPath(null)).toBe("/courses?view=owned");
  });

  it("sends Join now to the open professional course, else the catalogue (no made-up course)", () => {
    expect(selectFeaturedCoursePath(COURSES)).toBe("/courses/101");
    expect(selectFeaturedCoursePath([COURSES[1]])).toBe("/courses");
    expect(selectFeaturedCoursePath([])).toBe("/courses");
  });
});
