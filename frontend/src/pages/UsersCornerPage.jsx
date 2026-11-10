import "../features/users-corner/UsersCorner.scss";

import { ArrowRight, ArrowUpRight, Catalog, Launch, PlayFilledAlt, Time, Video } from "@carbon/icons-react";
import { Button, Tag } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import { listRealtimeSessions } from "../api/realtime";
import { siteBrand } from "../config/siteBrand";
import { CONSOLE_TITLE, getCornerTileGroups, isExternalNavItem } from "../features/app-shell/navConfig";
import { getNavIcon } from "../features/app-shell/navIcons";
import ReportsDueTile from "../features/reports/ReportsDueTile";
import { PageNotification, ProgressMeter, StatChips, StatChipsSkeleton } from "../features/app-shell/ui";
import { useLastCourseId } from "../features/app-shell/useLastCourseId";
import { sessionTypeLabel } from "../features/live-classes/liveSessions";
import { formatNextClass, formatScheduleSummary, getNextClassStart } from "../features/live-classes/schedule";
import {
  formatCountdown,
  formatHubDate,
  getAverageProgress,
  getCornerGreeting,
  getCountdown,
  getCountdownSegments,
  getCoursePreview,
  getLiveJoinPath,
  getLiveSummary,
  getStudentStats,
  pickContinueCourse,
} from "../features/users-corner/cornerModel";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { resolveCourseArtwork, resolveCourseArtworkFallback } from "../utils/courseArtwork";
import { formatCourseCategory, getCourseActionLabel, getCourseProgress } from "../utils/courseProgress";

const LIVE_REFRESH_MS = 60_000;
const CLOCK_TICK_MS = 30_000;

function CourseArtwork({ course, className }) {
  const fallback = resolveCourseArtworkFallback(course?.category);
  const [artwork, setArtwork] = useState(() => resolveCourseArtwork(course));

  useEffect(() => {
    setArtwork(resolveCourseArtwork({ category: course?.category, thumbnail: course?.thumbnail }));
  }, [course?.category, course?.thumbnail]);

  return (
    <div className={className} aria-hidden="true">
      {artwork ? (
        <img
          src={artwork}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setArtwork(fallback && artwork !== fallback ? fallback : "")}
        />
      ) : null}
      <span className="uc-art__shade" />
    </div>
  );
}

/** Placeholder bars shaped like the final content (announced once). */
function SkeletonBlock({ label, children, className = "" }) {
  return (
    <div className="uc-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">{label}</span>
      <div aria-hidden="true" className={className || undefined}>
        {children}
      </div>
    </div>
  );
}

const Bar = ({ variant }) => <span className={`cds-skeleton-bar cds-skeleton-bar--${variant}`} />;

/** "2026-11-10" in the viewer's own time zone (matches the visible date). */
function localIsoDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Greeting band: date, greeting, micro-stats and the next live class. */
function GreetingBand({ user, now, stats, averageProgress, showStats, statsLoading, live }) {
  const date = formatHubDate(now);
  const chips = [
    { id: "courses", label: stats.total === 1 ? "Course" : "Courses", value: stats.total },
    { id: "progress", label: "In progress", value: stats.inProgress },
    { id: "completed", label: "Completed", value: stats.completed },
    { id: "average", label: "Avg. progress", value: averageProgress, suffix: "%", accent: true },
  ];
  return (
    <section className="uc-hub-hero" aria-labelledby="uc-hub-title">
      <div className="uc-hub-hero__main">
        <p className="uc-hub-hero__eyebrow">
          <span>{CONSOLE_TITLE}</span>
          {date ? (
            <>
              <span className="uc-hub-hero__dot" aria-hidden="true" />
              <time dateTime={localIsoDate(now)}>{date}</time>
            </>
          ) : null}
        </p>
        <h1 id="uc-hub-title" className="uc-hub-hero__title">
          {getCornerGreeting(user)}
        </h1>
        <p className="uc-hub-hero__summary">Your courses, live classes and learning tools, all in one place.</p>
        {statsLoading ? <StatChipsSkeleton count={4} /> : null}
        {showStats ? <StatChips items={chips} className="uc-hub-hero__stats" /> : null}
      </div>
      <NextClassPanel {...live} now={now} />
    </section>
  );
}

/** "Live now" with Join, or a countdown to the next weekly class. */
function NextClassPanel({ liveSession, schedule, loading, now }) {
  if (loading) {
    return (
      <aside className="uc-next" aria-labelledby="uc-live-label">
        <p id="uc-live-label" className="uc-next__label">
          Live classes
        </p>
        <SkeletonBlock label="Loading live classes" className="uc-next__skeleton">
          <Bar variant="value" />
          <Bar variant="line" />
          <Bar variant="button" />
        </SkeletonBlock>
      </aside>
    );
  }

  if (liveSession) {
    const title = liveSession.title || "Your live class";
    const host = String(liveSession.host?.full_name || "").trim();
    const meta = [host ? `With ${host}` : "", liveSession.session_type ? sessionTypeLabel(liveSession.session_type) : ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <aside className="uc-next uc-next--live" aria-labelledby="uc-live-label">
        <p id="uc-live-label" className="uc-next__label">
          Live classes
        </p>
        <div className="uc-next__tags">
          <Tag type="red" size="md" className="uc-live-tag">
            <span className="uc-live-dot" aria-hidden="true" />
            Live now
          </Tag>
        </div>
        <h2 className="uc-next__title">{title}</h2>
        {meta ? <p className="uc-next__meta">{meta}</p> : null}
        <div className="uc-next__actions">
          <Button as={Link} to={getLiveJoinPath(liveSession)} renderIcon={ArrowRight}>
            Join class
          </Button>
        </div>
      </aside>
    );
  }

  const countdown = getCountdown(getNextClassStart(schedule, now), now);
  const segments = getCountdownSegments(countdown);
  const spoken = formatCountdown(countdown);
  return (
    <aside className="uc-next" aria-labelledby="uc-live-label">
      <p id="uc-live-label" className="uc-next__label">
        Next live class
      </p>
      {segments.length ? (
        <p className="uc-next__countdown">
          <span className="cds--visually-hidden">{spoken}</span>
          <span className="uc-next__digits" aria-hidden="true">
            {segments.map((segment) => (
              <span key={segment.unit} className="uc-next__segment">
                <span className="uc-next__number">{String(segment.value).padStart(2, "0")}</span>
                <span className="uc-next__unit">{segment.unit}</span>
              </span>
            ))}
          </span>
        </p>
      ) : (
        <p className="uc-next__countdown uc-next__countdown--now">{spoken || "Coming up"}</p>
      )}
      <p className="uc-next__when">
        <Time size={16} aria-hidden="true" />
        <span>{formatNextClass(schedule, now)}</span>
      </p>
      <p className="uc-next__meta">Every week · {formatScheduleSummary(schedule)}</p>
      <div className="uc-next__actions">
        <Button as={Link} to="/join-live" kind="tertiary" renderIcon={Video}>
          Live classes
        </Button>
      </div>
    </aside>
  );
}

/** The last course opened (or the best next one), with one clear action. */
function ContinueCard({ course, loading, error }) {
  let body;
  if (loading) {
    body = (
      <SkeletonBlock label="Loading your courses" className="uc-continue">
        <span className="uc-continue__art uc-skeleton__art" />
        <span className="uc-continue__body">
          <Bar variant="tag" />
          <Bar variant="title" />
          <Bar variant="line" />
          <Bar variant="button" />
        </span>
      </SkeletonBlock>
    );
  } else if (error) {
    body = <p className="uc-card__text">Your courses couldn&apos;t be loaded right now.</p>;
  } else if (!course) {
    body = (
      <div className="uc-card__empty">
        <h2 className="uc-card__title">Start your first course</h2>
        <p className="uc-card__text">Your purchased or approved courses will appear here.</p>
        <div className="uc-card__actions">
          <Button as={Link} to="/courses" renderIcon={Catalog}>
            Browse courses
          </Button>
        </div>
      </div>
    );
  } else {
    const progress = getCourseProgress(course);
    const actionLabel = getCourseActionLabel(progress);
    const title = course.title || "Your course";
    body = (
      <div className="uc-continue">
        <Link to={`/learn/${Number(course.id)}`} className="uc-continue__media" tabIndex={-1} aria-hidden="true">
          <CourseArtwork course={course} className="uc-continue__art" />
          <span className="uc-continue__play">
            <PlayFilledAlt size={20} />
          </span>
        </Link>
        <div className="uc-continue__body">
          <div className="uc-card__tags">
            <Tag type="gray" size="sm">
              {formatCourseCategory(course.category)}
            </Tag>
          </div>
          <h2 className="uc-card__title">{title}</h2>
          <ProgressMeter progress={progress} name={title} className="uc-card__progress" />
          <div className="uc-card__actions">
            <Button
              as={Link}
              to={`/learn/${Number(course.id)}`}
              renderIcon={PlayFilledAlt}
              aria-label={`${actionLabel}: ${title}`}
            >
              {actionLabel}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <article className="uc-card uc-card--continue" aria-labelledby="uc-continue-label">
      <p id="uc-continue-label" className="uc-card__label">
        Continue learning
      </p>
      {body}
    </article>
  );
}

/** Owned-course card: artwork with a soft shade, title (the link), progress. */
function CornerCourseCard({ course }) {
  const progress = getCourseProgress(course);
  const title = course.title || "Your course";
  return (
    <li className="uc-course">
      <div className="uc-course__media">
        <CourseArtwork course={course} className="uc-course__art" />
        <span className="uc-course__category">{formatCourseCategory(course.category)}</span>
      </div>
      <div className="uc-course__body">
        <h3 className="uc-course__title">
          <Link to={`/learn/${Number(course.id)}`} className="uc-course__link">
            {title}
          </Link>
        </h3>
        <ProgressMeter progress={progress} name={title} className="uc-course__progress" />
      </div>
    </li>
  );
}

function CoursesSection({ courses, preview, loading, error, onRetry }) {
  // With no courses the Continue card already offers "Browse courses".
  if (!loading && !error && courses.length === 0) return null;
  return (
    <section className="uc-section" aria-labelledby="uc-courses-title">
      <div className="uc-section__header">
        <h2 id="uc-courses-title" className="uc-section__title">
          My courses
        </h2>
        {courses.length > 0 ? (
          <Link to="/my-courses" className="uc-section__link">
            View all
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      {loading ? (
        <SkeletonBlock label="Loading your courses">
          <ul className="uc-courses">
            {[0, 1, 2].map((index) => (
              <li key={index} className="uc-course uc-course--skeleton">
                <span className="uc-course__media uc-skeleton__art" />
                <span className="uc-course__body">
                  <Bar variant="title" />
                  <Bar variant="line" />
                  <Bar variant="track" />
                </span>
              </li>
            ))}
          </ul>
        </SkeletonBlock>
      ) : null}

      {!loading && error ? (
        <PageNotification
          kind="error"
          title="Couldn't load your courses."
          subtitle={error}
          actionLabel={onRetry ? "Try again" : undefined}
          onAction={onRetry}
        />
      ) : null}

      {!loading && !error && preview.length > 0 ? (
        <ul className="uc-courses" aria-label="Your courses">
          {preview.map((course) => (
            <CornerCourseCard key={course.id} course={course} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function TileBody({ item, Icon, external }) {
  const hintId = `uc-tile-hint-${item.id}`;
  return (
    <>
      <span className="uc-tile__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="uc-tile__text">
        <span className="uc-tile__label">{item.label}</span>
        {item.hint ? (
          <span id={hintId} className="uc-tile__hint">
            {item.hint}
          </span>
        ) : null}
      </span>
      {external ? (
        <>
          <Launch size={16} aria-hidden="true" className="uc-tile__arrow" />
          <span className="cds--visually-hidden"> (opens in a new tab)</span>
        </>
      ) : (
        <ArrowUpRight size={16} aria-hidden="true" className="uc-tile__arrow" />
      )}
    </>
  );
}

/** Shortcut tiles for every destination: icon, label and a one-line hint. */
function CornerTiles({ groups }) {
  return groups.map((group) => (
    <section key={group.id} className="uc-section" aria-labelledby={`uc-tiles-${group.id}`}>
      <div className="uc-section__header">
        <h2 id={`uc-tiles-${group.id}`} className="uc-section__title">
          {group.label}
        </h2>
      </div>
      <ul className="uc-tiles">
        {group.items.map((item) => {
          const Icon = getNavIcon(item.icon);
          if (isExternalNavItem(item)) {
            return (
              <li key={item.id}>
                <a
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="uc-tile uc-tile--external"
                  aria-describedby={item.hint ? `uc-tile-hint-${item.id}` : undefined}
                >
                  <TileBody item={item} Icon={Icon} external />
                </a>
              </li>
            );
          }
          return (
            <li key={item.id}>
              <Link
                to={item.to}
                className="uc-tile"
                aria-describedby={item.hint ? `uc-tile-hint-${item.id}` : undefined}
              >
                <TileBody item={item} Icon={Icon} />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  ));
}

/** Presentational hub, also used by tests and the visual harness. */
export function UsersCornerView({
  user,
  tileGroups = [],
  courses = [],
  coursesLoading = false,
  coursesError = "",
  onRetryCourses,
  liveSession = null,
  schedule = null,
  liveLoading = false,
  lastCourseId = "",
  now = new Date(),
}) {
  const list = useMemo(() => (Array.isArray(courses) ? courses : []), [courses]);
  const continueCourse = useMemo(() => pickContinueCourse(list, lastCourseId), [list, lastCourseId]);
  const preview = useMemo(() => getCoursePreview(list, continueCourse), [list, continueCourse]);
  const stats = useMemo(() => getStudentStats(list), [list]);
  const averageProgress = useMemo(() => getAverageProgress(list), [list]);
  const showStats = !coursesLoading && !coursesError && stats.total > 0;

  return (
    <div className="uc-hub">
      <GreetingBand
        user={user}
        now={now}
        stats={stats}
        averageProgress={averageProgress}
        showStats={showStats}
        statsLoading={coursesLoading}
        live={{ liveSession, schedule, loading: liveLoading }}
      />

      <ContinueCard course={continueCourse} loading={coursesLoading} error={coursesError} />

      {/* Weekly reports: "Next report due …" (renders nothing when nothing is due). */}
      <ReportsDueTile />

      <CoursesSection
        courses={list}
        preview={preview}
        loading={coursesLoading}
        error={coursesError}
        onRetry={onRetryCourses}
      />

      <CornerTiles groups={tileGroups} />
    </div>
  );
}

/** Re-renders every `intervalMs` so the date and countdown stay current. */
function useNow(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function UsersCornerPage() {
  const auth = useAuth();
  const { pathname } = useLocation();
  const lastCourseId = useLastCourseId(pathname);
  const now = useNow(CLOCK_TICK_MS);
  const [courses, setCourses] = useState([]);
  const [coursesLoading, setCoursesLoading] = useState(true);
  const [coursesError, setCoursesError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [sessions, setSessions] = useState([]);
  const [liveLoading, setLiveLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setCoursesLoading(true);
    setCoursesError("");
    (async () => {
      try {
        const response = await getMyCourses();
        const myCourses = apiData(response, []);
        if (active) setCourses(Array.isArray(myCourses) ? myCourses : []);
      } catch (err) {
        if (active) setCoursesError(apiMessage(err, "Please check your connection and try again."));
      } finally {
        if (active) setCoursesLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await listRealtimeSessions({ status: "all" });
        const data = apiData(response, []);
        if (active) setSessions(Array.isArray(data) ? data.filter((item) => item?.status !== "ended") : []);
      } catch {
        // Keep the last list; the panel falls back to the weekly schedule.
      } finally {
        if (active) setLiveLoading(false);
      }
    };
    load();
    const refreshId = window.setInterval(load, LIVE_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(refreshId);
    };
  }, []);

  const retryCourses = useCallback(() => setAttempt((value) => value + 1), []);
  const live = useMemo(() => getLiveSummary(sessions), [sessions]);
  const tileGroups = useMemo(
    () => getCornerTileGroups(auth, { lastCourseId, brandId: siteBrand.id }),
    [auth, lastCourseId]
  );

  return (
    <UsersCornerView
      user={auth.user}
      tileGroups={tileGroups}
      courses={courses}
      coursesLoading={coursesLoading}
      coursesError={coursesError}
      onRetryCourses={retryCourses}
      liveSession={live.liveSession}
      schedule={live.schedule}
      liveLoading={liveLoading}
      lastCourseId={lastCourseId}
      now={now}
    />
  );
}
