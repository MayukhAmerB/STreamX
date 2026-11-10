import "../features/users-corner/UsersCorner.scss";

import { ArrowRight, Catalog, Education, PlayFilledAlt, Video } from "@carbon/icons-react";
import { Button, ProgressBar, SkeletonText, Tag } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getMyCourses } from "../api/courses";
import { listRealtimeSessions } from "../api/realtime";
import { getCornerTileGroups } from "../features/app-shell/navConfig";
import { getNavIcon } from "../features/app-shell/navIcons";
import { EmptyState, PageNotification } from "../features/app-shell/ui";
import { useLastCourseId } from "../features/app-shell/useLastCourseId";
import { sessionTypeLabel } from "../features/live-classes/liveSessions";
import { formatNextClass, formatScheduleSummary } from "../features/live-classes/schedule";
import {
  getCornerGreeting,
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
    </div>
  );
}

function CardSkeleton({ label }) {
  return (
    <div className="uc-card__skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">{label}</span>
      <div aria-hidden="true">
        <SkeletonText heading width="60%" />
        <SkeletonText paragraph lineCount={2} />
      </div>
    </div>
  );
}

/** The last course opened (or the best next one), with one clear action. */
function ContinueCard({ course, loading, error }) {
  let body;
  if (loading) {
    body = <CardSkeleton label="Loading your courses" />;
  } else if (error) {
    body = <p className="uc-card__text">Your courses couldn&apos;t be loaded right now.</p>;
  } else if (!course) {
    body = (
      <>
        <h2 className="uc-card__title">Start your first course</h2>
        <p className="uc-card__text">Your purchased or approved courses will appear here.</p>
        <div className="uc-card__actions">
          <Button as={Link} to="/courses" renderIcon={Catalog}>
            Browse courses
          </Button>
        </div>
      </>
    );
  } else {
    const progress = getCourseProgress(course);
    const actionLabel = getCourseActionLabel(progress);
    const title = course.title || "Your course";
    body = (
      <div className="uc-continue">
        <CourseArtwork course={course} className="uc-continue__art" />
        <div className="uc-continue__body">
          <div className="uc-card__tags">
            <Tag type="gray" size="sm">
              {formatCourseCategory(course.category)}
            </Tag>
          </div>
          <h2 className="uc-card__title">{title}</h2>
          <ProgressBar
            className="uc-card__progress"
            label={`${progress.percent}% complete`}
            helperText={progress.summary}
            value={progress.percent}
            size="small"
            status={progress.status === "completed" ? "finished" : "active"}
          />
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

/** "Live now" with a Join button, or when the next class is. */
function LiveCard({ liveSession, schedule, loading }) {
  if (loading) {
    return (
      <article className="uc-card uc-card--live" aria-labelledby="uc-live-label">
        <p id="uc-live-label" className="uc-card__label">
          Live classes
        </p>
        <CardSkeleton label="Loading live classes" />
      </article>
    );
  }

  if (liveSession) {
    const title = liveSession.title || "Your live class";
    const host = String(liveSession.host?.full_name || "").trim();
    const meta = [host ? `With ${host}` : "", liveSession.session_type ? sessionTypeLabel(liveSession.session_type) : ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <article className="uc-card uc-card--live uc-card--is-live" aria-labelledby="uc-live-label">
        <p id="uc-live-label" className="uc-card__label">
          Live classes
        </p>
        <div className="uc-card__tags">
          <Tag type="red" size="md" className="uc-live-tag">
            <span className="uc-live-dot" aria-hidden="true" />
            Live now
          </Tag>
        </div>
        <h2 className="uc-card__title">{title}</h2>
        {meta ? <p className="uc-card__text">{meta}</p> : null}
        <div className="uc-card__actions">
          <Button as={Link} to={getLiveJoinPath(liveSession)} renderIcon={ArrowRight}>
            Join class
          </Button>
        </div>
      </article>
    );
  }

  return (
    <article className="uc-card uc-card--live" aria-labelledby="uc-live-label">
      <p id="uc-live-label" className="uc-card__label">
        Next live class
      </p>
      <h2 className="uc-card__title">{formatNextClass(schedule)}</h2>
      <p className="uc-card__text">Every week · {formatScheduleSummary(schedule)}</p>
      <div className="uc-card__actions">
        <Button as={Link} to="/join-live" kind="tertiary" renderIcon={Video}>
          Live classes
        </Button>
      </div>
    </article>
  );
}

/** Compact owned-course card: artwork, title (the link), progress. */
function CornerCourseCard({ course }) {
  const progress = getCourseProgress(course);
  const title = course.title || "Your course";
  return (
    <li className="uc-course">
      <CourseArtwork course={course} className="uc-course__art" />
      <div className="uc-course__body">
        <div className="uc-card__tags">
          <Tag type="gray" size="sm">
            {formatCourseCategory(course.category)}
          </Tag>
          {progress.status === "completed" ? (
            <Tag type="green" size="sm">
              Completed
            </Tag>
          ) : null}
        </div>
        <h3 className="uc-course__title">
          <Link to={`/learn/${Number(course.id)}`} className="uc-course__link">
            {title}
          </Link>
        </h3>
        <ProgressBar
          className="uc-course__progress"
          label={`${progress.percent}% complete`}
          helperText={progress.summary}
          value={progress.percent}
          size="small"
          status={progress.status === "completed" ? "finished" : "active"}
        />
      </div>
    </li>
  );
}

function CoursesSection({ courses, preview, loading, error, onRetry }) {
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
        <div className="uc-courses uc-courses--loading">
          <CardSkeleton label="Loading your courses" />
        </div>
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

      {!loading && !error && courses.length === 0 ? (
        <EmptyState
          icon={Education}
          text="Your purchased or approved courses will appear here."
          action={
            <Button as={Link} to="/courses" kind="tertiary" renderIcon={Catalog}>
              Browse courses
            </Button>
          }
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

/** Big icon tiles for every destination in User's Corner. */
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
          return (
            <li key={item.id}>
              <Link to={item.to} className="uc-tile" aria-label={item.label}>
                <Icon size={32} aria-hidden="true" className="uc-tile__icon" />
                <span className="uc-tile__label">{item.shortLabel || item.label}</span>
                <ArrowRight size={16} aria-hidden="true" className="uc-tile__arrow" />
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
}) {
  const list = useMemo(() => (Array.isArray(courses) ? courses : []), [courses]);
  const continueCourse = useMemo(() => pickContinueCourse(list, lastCourseId), [list, lastCourseId]);
  const preview = useMemo(() => getCoursePreview(list, continueCourse), [list, continueCourse]);
  const stats = useMemo(() => getStudentStats(list), [list]);
  const showStats = !coursesLoading && !coursesError && stats.total > 0;

  return (
    <div className="uc-hub">
      <section className="uc-hub-hero" aria-labelledby="uc-hub-title">
        <p className="uc-hub-hero__eyebrow" aria-hidden="true">
          Overview
        </p>
        <h1 id="uc-hub-title" className="uc-hub-hero__title">
          {getCornerGreeting(user)}
        </h1>
        <p className="uc-hub-hero__summary">Your courses, live classes and learning tools, all in one place.</p>
        {showStats ? (
          <ul className="uc-hub-hero__stats" aria-label="Your progress">
            <li>
              {stats.total} {stats.total === 1 ? "course" : "courses"}
            </li>
            <li>{stats.inProgress} in progress</li>
            <li>{stats.completed} completed</li>
          </ul>
        ) : null}
      </section>

      <div className="uc-hub__feature">
        <ContinueCard course={continueCourse} loading={coursesLoading} error={coursesError} />
        <LiveCard liveSession={liveSession} schedule={schedule} loading={liveLoading} />
      </div>

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

export default function UsersCornerPage() {
  const auth = useAuth();
  const { pathname } = useLocation();
  const lastCourseId = useLastCourseId(pathname);
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
        // Keep the last list; the card falls back to the weekly schedule.
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
  const tileGroups = useMemo(() => getCornerTileGroups(auth, { lastCourseId }), [auth, lastCourseId]);

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
    />
  );
}
