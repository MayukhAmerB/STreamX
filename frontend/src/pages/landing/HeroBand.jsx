import { useEffect, useState } from "react";

import { COURSE_TRACKS } from "../../components/CourseCategorySelector";
import { Band, Button, ClickableTile, Column, InlineNotification, Link, Tag } from "../../site-kit";
import { describeTrackAvailability } from "../../utils/catalogTracks";
import { getCourseCategoryPath } from "../../utils/courseCatalog";
import { getCountdownParts, selectActiveCourseCountdown } from "../../utils/courseCountdown";
import { ArrowRight } from "./LandingParts";
import { HERO_EYEBROW, HERO_SUMMARY, TRUST_ITEMS } from "./landingContent";
import { countCoursesByTrack, liveBroadcastJoinPath } from "./useLandingData";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The two track tiles. Availability comes from the server's `tracks[]`
 * (plan §7.2 rule 1): a track whose state is not "open" is a disabled tile
 * ("Coming soon · No courses yet", no arrow, not navigable). When the server
 * said nothing (e.g. the request failed) the tile stays a link, never guessed closed.
 */
export function TrackTiles({ courses = [], tracks }) {
  const fallbackCounts = countCoursesByTrack(courses);
  return (
    <ul className="lp-tracks" aria-label="Professional tracks">
      {COURSE_TRACKS.map((track) => {
        // No server answer and nothing cached: say nothing rather than a misleading "0 courses".
        // A closed track shows its "Coming soon" tag and reason, never a count.
        const fallbackCount = courses.length ? Number(fallbackCounts[track.category] || 0) : null;
        const { closed, count, reason } = describeTrackAvailability(tracks, track.category, fallbackCount);
        const body = (
          <>
            <div className="lp-track__top">
              <span className="lp-track__kind">Professional track</span>
              <span className="lp-track__count">
                {closed ? <Tag type="coming-soon" size="sm" /> : null}
                {count === null ? null : `${count} course${count === 1 ? "" : "s"}`}
              </span>
            </div>
            <div className="lp-track__head">
              <span className="lp-track__logo">
                <img src={track.image} alt="" width="640" height="640" loading="eager" decoding="async" />
              </span>
              <div className="lp-track__names">
                <h3 className="lp-track__title">{track.title}</h3>
                <p className="lp-track__subtitle">{track.subtitle}</p>
              </div>
            </div>
            <p className="lp-track__desc">{track.description}</p>
            {closed ? null : (
              <span className="lp-track__cta">
                View all courses
                <ArrowRight />
              </span>
            )}
          </>
        );
        return (
          <li key={track.category} className="lp-tracks__item" data-track={track.category} data-state={closed ? "coming_soon" : "open"}>
            {closed ? (
              <ClickableTile disabled disabledReason={reason} className="lp-track">
                {body}
              </ClickableTile>
            ) : (
              <ClickableTile href={getCourseCategoryPath(track.category)} hideArrow className="lp-track">
                {body}
              </ClickableTile>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const TIMER_UNITS = [
  ["days", "Days"],
  ["hours", "Hours"],
  ["minutes", "Minutes"],
  ["seconds", "Seconds"],
];

/**
 * Enrollment countdown (plan §7.1 motion): neutral colours, updates once a
 * minute and every second only in the last hour, with a pause control
 * (WCAG 2.2.2). Same label and course title as before.
 */
export function HeroCountdownStrip({ courses }) {
  const [now, setNow] = useState(() => Date.now());
  const [paused, setPaused] = useState(false);
  const active = selectActiveCourseCountdown(courses, now);
  const deadline = active?.deadline || "";
  const remaining = deadline ? Date.parse(deadline) - now : 0;
  const lastHour = remaining > 0 && remaining <= HOUR_MS;

  useEffect(() => {
    if (!deadline || paused) return undefined;
    const step = lastHour ? 1000 : 60000;
    const current = Date.now();
    const timer = window.setTimeout(() => setNow(Date.now()), step - (current % step) + 25);
    return () => window.clearTimeout(timer);
  }, [deadline, paused, lastHour, now]);

  if (!active) return null;
  const parts = getCountdownParts(deadline, now) || { days: 0, hours: 0, minutes: 0, seconds: 0 };
  const units = TIMER_UNITS.filter(([key]) => key !== "seconds" || lastHour);
  const courseTitle = active.course?.card_title || active.course?.title;

  return (
    <div className="lp-countdown" role="group" aria-label="Enrollment countdown">
      <div className="lp-countdown__text">
        <p className="lp-countdown__label">{active.label}</p>
        {courseTitle ? <p className="lp-countdown__title">{courseTitle}</p> : null}
      </div>
      <time dateTime={deadline} className="lp-countdown__timer" role="timer" aria-live="off" data-units={units.length}>
        {units.map(([key, label]) => (
          <span key={key} className="lp-countdown__unit">
            <span className="lp-countdown__value">{String(parts[key]).padStart(2, "0")}</span>
            <span className="lp-countdown__unit-label">{label}</span>
          </span>
        ))}
      </time>
      <button
        type="button"
        className="lp-countdown__pause"
        aria-pressed={paused}
        onClick={() => {
          setPaused((value) => !value);
          setNow(Date.now());
        }}
      >
        {paused ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M4 2.5v11l9-5.5z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M4 2h3v12H4zM9 2h3v12H9z" />
          </svg>
        )}
        <span>{paused ? "Resume countdown" : "Pause countdown"}</span>
      </button>
    </div>
  );
}

/** Band 1 (g100): copy, actions, the live notice, the two track tiles and the countdown strip. */
export default function HeroBand({ theme = "g100", isAuthenticated, liveBroadcast, courses, tracks }) {
  const trackCount = COURSE_TRACKS.length;
  const hasCountdown = Boolean(selectActiveCourseCountdown(courses, Date.now()));
  return (
    <Band theme={theme} className="lp-band lp-hero" labelledBy="lp-hero-title">
      <Column sm={4} md={8} lg={8} className="lp-hero__copy">
        <p className="lp-eyebrow lp-eyebrow--rule">{HERO_EYEBROW}</p>

        {liveBroadcast ? (
          <InlineNotification
            kind="info"
            lowContrast
            className="lp-hero__live"
            title={
              <span className="lp-hero__live-title">
                <Tag type="live" size="sm" />
                Class is live
              </span>
            }
            subtitle={liveBroadcast.title || "Join your live classroom"}
            action={
              <Link href={isAuthenticated ? liveBroadcastJoinPath(liveBroadcast) : "/login"} arrow className="lp-hero__live-link">
                Join now
              </Link>
            }
          />
        ) : null}

        <h1 id="lp-hero-title" className="lp-hero__title">
          <span className="lp-hero__line">Learn practical</span> <span className="lp-hero__line">cyber skills.</span>
          <span className="lp-hero__sub">Build real capability.</span>
        </h1>

        <p className="lp-lead lp-hero__summary">{HERO_SUMMARY}</p>

        <ul className="lp-trust">
          {TRUST_ITEMS.map((label) => (
            <li key={label}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M6.5 11.2 3.3 8l-.7.7 3.9 3.9 7-7-.7-.7z" />
              </svg>
              {label}
            </li>
          ))}
        </ul>

        <div className="lp-actions">
          <Button href="/courses" icon={<ArrowRight />}>
            Browse Courses
          </Button>
          <Button kind="tertiary" href={isAuthenticated ? "/console" : "/login"} icon={<ArrowRight />}>
            {isAuthenticated ? "Console" : "Get Started"}
          </Button>
        </div>
      </Column>

      <Column sm={4} md={8} lg={8} className="lp-hero__programs">
        <div className="lp-hero__programs-head">
          <p className="lp-label">Featured programs</p>
          <h2 className="lp-h3">Choose your training path</h2>
          <p className="lp-label">
            {trackCount} professional track{trackCount === 1 ? "" : "s"}
          </p>
        </div>
        <TrackTiles courses={courses} tracks={tracks} />
      </Column>

      {hasCountdown ? (
        <Column sm={4} md={8} lg={16} className="lp-hero__countdown">
          <HeroCountdownStrip courses={courses} />
        </Column>
      ) : null}
    </Band>
  );
}
