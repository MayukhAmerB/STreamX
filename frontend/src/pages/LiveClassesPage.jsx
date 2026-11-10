import "../features/live-classes/LiveClasses.scss";

import { ArrowLeft, ArrowRight, Locked, Video } from "@carbon/icons-react";
import { Button, SkeletonPlaceholder, SkeletonText } from "@carbon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getCourse, listLiveClasses } from "../api/courses";
import { joinRealtimeSession, listRealtimeSessions } from "../api/realtime";
import { EmptyState, PageHeader, PageNotification, PageSkeleton } from "../features/app-shell/ui";
import { LiveTrackTile } from "../features/live-classes/LiveCards";
import LiveStage from "../features/live-classes/LiveStage";
import { formatNextClass, formatScheduleSummary } from "../features/live-classes/schedule";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";
import {
  findJoinableLiveSession,
  resolveLiveClassSchedule,
} from "../utils/liveClassSchedule";
import {
  reconcileActiveLivePayload,
  retainRealtimeSessionsOnRefresh,
} from "../utils/realtimeSessionResilience";

const fallbackLiveClasses = [
  {
    id: "osint-beginner-fallback",
    title: "OSINT Live Class - Month 1 (Beginner)",
    level: "beginner",
    month_number: 1,
    description:
      "Foundational OSINT training covering introduction, intelligence lifecycle, legal boundaries, search engine intelligence, and SOCMINT basics.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 1499,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
    linked_course_id: null,
    linked_course_title: "OSINT Beginner",
  },
  {
    id: "osint-intermediate-fallback",
    title: "OSINT Live Class - Month 2 (Intermediate)",
    level: "intermediate",
    month_number: 2,
    description:
      "Practical OSINT workflows for people and identity research, image/video analysis, domain intelligence, tools, and advanced search techniques.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 2499,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
    linked_course_id: null,
    linked_course_title: "OSINT Intermediate",
  },
  {
    id: "osint-advanced-fallback",
    title: "OSINT Live Class - Month 3 (Advanced)",
    level: "advanced",
    month_number: 3,
    description:
      "Advanced investigation and intelligence workflows including dark web OSINT, profiling, geolocation, archive analysis, and end-to-end investigations.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 3999,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
    linked_course_id: null,
    linked_course_title: "OSINT Advanced",
  },
];

const monthByLevel = {
  beginner: { month: 1, label: "Month 1", subtitle: "Foundation" },
  intermediate: { month: 2, label: "Month 2", subtitle: "Practical Skills" },
  advanced: { month: 3, label: "Month 3", subtitle: "Investigation & Intelligence" },
};

const levelOrder = { beginner: 1, intermediate: 2, advanced: 3 };

function _isOsintCourse(course) {
  const category = String(course?.category || "").toLowerCase();
  const title = String(course?.title || "").toLowerCase();
  return category === "osint" || title.includes("osint");
}

function formatLevel(level) {
  if (!level) return "Program";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function formatLiveClassPrice(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return "Free";
  return formatINR(amount);
}

function toValidLiveClassId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function hasApprovedCourseAccess(course) {
  const status = String(course?.enrollment_status || "").toLowerCase();
  return Boolean(course?.is_enrolled) || status === "approved" || status === "paid";
}

export function sessionBelongsToCourse(session, courseId) {
  const normalizedCourseId = Number(courseId || 0);
  if (!normalizedCourseId) return true;
  const linkedCourseId = Number(
    session?.linked_course?.id || session?.linked_live_class?.linked_course_id || 0
  );
  return linkedCourseId === normalizedCourseId;
}

export default function LiveClassesPage() {
  const { id: routeCourseId } = useParams();
  const { user, isAuthenticated } = useAuth();
  const scopedCourseId = toValidLiveClassId(routeCourseId);
  const isCourseClassroom = Boolean(scopedCourseId);
  const [course, setCourse] = useState(null);
  const [courseLoading, setCourseLoading] = useState(isCourseClassroom);
  const [courseError, setCourseError] = useState("");
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [realtimeSessions, setRealtimeSessions] = useState([]);
  const [activeLivePayload, setActiveLivePayload] = useState(null);
  const [liveJoinState, setLiveJoinState] = useState({ loading: false, error: "" });
  const liveStageRef = useRef(null);
  const [courseAttempt, setCourseAttempt] = useState(0);
  const [tracksAttempt, setTracksAttempt] = useState(0);

  useEffect(() => {
    if (!isCourseClassroom) {
      setCourse(null);
      setCourseLoading(false);
      setCourseError("");
      return undefined;
    }

    let active = true;
    setCourseLoading(true);
    (async () => {
      try {
        const response = await getCourse(scopedCourseId);
        if (!active) return;
        setCourse(apiData(response, null));
        setCourseError("");
      } catch (err) {
        if (!active) return;
        setCourse(null);
        setCourseError(apiMessage(err, "Unable to load this course classroom."));
      } finally {
        if (active) setCourseLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [courseAttempt, isCourseClassroom, scopedCourseId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    (async () => {
      try {
        const response = await listLiveClasses(
          isCourseClassroom ? { course_id: scopedCourseId } : {}
        );
        if (!active) return;
        const liveClasses = apiData(response, []);
        setTracks(
          liveClasses.length || isCourseClassroom ? liveClasses : fallbackLiveClasses
        );
        setError("");
      } catch (err) {
        if (!active) return;
        setTracks(isCourseClassroom ? [] : fallbackLiveClasses);
        setError(
          isCourseClassroom
            ? apiMessage(err, "Unable to load this course's live classes.")
            : "Showing local OSINT live classes preview. Backend is unavailable."
        );
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [isCourseClassroom, scopedCourseId, tracksAttempt]);

  useEffect(() => {
    if (!isAuthenticated) {
      setRealtimeSessions([]);
      return undefined;
    }
    let active = true;
    const loadRealtimeSessions = async () => {
      try {
        const response = await listRealtimeSessions({ status: "all" });
        if (!active) return;
        const rows = apiData(response, []);
        setRealtimeSessions((previous) => retainRealtimeSessionsOnRefresh(rows, previous));
      } catch {
        // Keep the last successful state. A temporary API failure must not
        // unmount an active broadcast and send viewers back to Join Now.
      }
    };
    loadRealtimeSessions();
    const refreshId = window.setInterval(loadRealtimeSessions, 10_000);
    return () => {
      active = false;
      window.clearInterval(refreshId);
    };
  }, [isAuthenticated]);

  const scopedRealtimeSessions = useMemo(
    () =>
      realtimeSessions.filter((session) =>
        sessionBelongsToCourse(session, scopedCourseId)
      ),
    [realtimeSessions, scopedCourseId]
  );
  const liveSchedule = useMemo(
    () => resolveLiveClassSchedule(scopedRealtimeSessions),
    [scopedRealtimeSessions]
  );
  const activeLiveSession = useMemo(
    () => findJoinableLiveSession(scopedRealtimeSessions),
    [scopedRealtimeSessions]
  );
  const legacySessionId = activeLivePayload?.session?.id || activeLiveSession?.id;
  const legacyLiveHref = legacySessionId
    ? `/join-live?session=${legacySessionId}`
    : "/join-live";

  useEffect(() => {
    setActiveLivePayload((previous) =>
      reconcileActiveLivePayload(previous, scopedRealtimeSessions)
    );
  }, [scopedRealtimeSessions]);

  const orderedTracks = useMemo(() => {
    return [...tracks].sort((a, b) => {
      const aLevel = levelOrder[String(a?.level || "").toLowerCase()] || a?.month_number || 99;
      const bLevel = levelOrder[String(b?.level || "").toLowerCase()] || b?.month_number || 99;
      if (aLevel !== bLevel) return aLevel - bLevel;
      return String(a?.title || "").localeCompare(String(b?.title || ""));
    });
  }, [tracks]);

  const handleJoinLiveClass = async (sessionId) => {
    setLiveJoinState({ loading: true, error: "" });
    try {
      const requestedSession = scopedRealtimeSessions.find(
        (session) => String(session.id) === String(sessionId),
      );
      const response = await joinRealtimeSession(sessionId, {
        display_name: user?.full_name || "",
        prefer_broadcast: requestedSession?.session_type === "broadcasting",
      });
      const payload = apiData(response, null);
      setActiveLivePayload(payload);
      setLiveJoinState({ loading: false, error: "" });
      window.requestAnimationFrame(() => {
        liveStageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return payload;
    } catch (err) {
      setLiveJoinState({
        loading: false,
        error: apiMessage(err, "Unable to open the live classroom."),
      });
      throw err;
    }
  };

  const isWatching = activeLivePayload?.mode === "broadcast" || activeLivePayload?.mode === "meeting";
  const scheduleSummary = formatScheduleSummary(liveSchedule);
  const nextClassLabel = formatNextClass(liveSchedule);
  const courseHref = `/courses/${scopedCourseId}`;
  const leaveLiveClass = () => {
    setActiveLivePayload(null);
    setLiveJoinState({ loading: false, error: "" });
  };

  if (courseLoading) {
    return (
      <div className="lc-page">
        <PageSkeleton label="Loading your live classroom" count={2} />
      </div>
    );
  }

  if (isCourseClassroom && (courseError || !course)) {
    return (
      <div className="lc-page">
        <PageHeader title="Live classes" />
        <PageNotification
          kind="error"
          title="Couldn't open this classroom."
          subtitle={courseError || "Course not found."}
          actionLabel="Try again"
          onAction={() => setCourseAttempt((value) => value + 1)}
        />
        <Button as={Link} to={courseHref} kind="ghost" renderIcon={ArrowLeft}>
          Back to course
        </Button>
      </div>
    );
  }

  if (isCourseClassroom && !hasApprovedCourseAccess(course)) {
    return (
      <div className="lc-page">
        <PageHeader title="Live classes" description={course.title} />
        <EmptyState
          icon={Locked}
          text="Live classes are included with approved course access."
          action={
            <Button as={Link} to={courseHref} renderIcon={ArrowRight}>
              View course access
            </Button>
          }
        />
      </div>
    );
  }

  const pageTitle = "Live classes";
  const pageDescription = isCourseClassroom ? course.title : "OSINT live programme, month by month.";

  return (
    <div className={`lc-page${isWatching ? " lc-page--watching" : ""}`}>
      {isWatching ? (
        <h1 className="lc-visually-hidden">
          {pageTitle}: {isCourseClassroom ? course.title : "OSINT live programme"}
        </h1>
      ) : (
        <PageHeader title={pageTitle} description={pageDescription} />
      )}

      <section ref={liveStageRef} className="lc-stage-anchor" aria-label="Live class">
        <LiveStage
          schedule={liveSchedule}
          liveSession={activeLiveSession}
          activePayload={activeLivePayload}
          joining={liveJoinState.loading}
          error={liveJoinState.error}
          legacyHref={legacyLiveHref}
          onJoin={handleJoinLiveClass}
          onLeave={leaveLiveClass}
        />
      </section>

      <section className="lc-section" aria-labelledby="lc-tracks-title">
        <div className="lc-section__header">
          <h2 id="lc-tracks-title" className="lc-section__title">
            {isCourseClassroom ? "Included live classes" : "Month-by-month live classes"}
          </h2>
          {!loading ? (
            <p className="lc-section__count">
              {orderedTracks.length} live class{orderedTracks.length === 1 ? "" : "es"}
            </p>
          ) : null}
        </div>

        {error ? (
          <PageNotification
            kind={isCourseClassroom ? "error" : "warning"}
            title={isCourseClassroom ? "Couldn't load the live classes." : "Showing a preview of the live classes."}
            subtitle={error}
            actionLabel="Try again"
            onAction={() => setTracksAttempt((value) => value + 1)}
          />
        ) : null}

        {loading ? (
          <div className="cds-tile-grid" role="status" aria-live="polite" aria-busy="true">
            <span className="lc-visually-hidden">Loading live classes</span>
            {[0, 1, 2].map((index) => (
              <div key={index} className="lc-track lc-track--skeleton" aria-hidden="true">
                <SkeletonPlaceholder style={{ width: "6rem", height: "1.5rem" }} />
                <SkeletonText heading width="80%" />
                <SkeletonText paragraph lineCount={3} />
              </div>
            ))}
          </div>
        ) : orderedTracks.length > 0 ? (
          <div className="cds-tile-grid">
            {orderedTracks.map((track) => {
              const levelKey = String(track?.level || "").toLowerCase();
              const monthMeta = monthByLevel[levelKey] || {
                month: 0,
                label: track?.month_number ? `Month ${track.month_number}` : "Live class",
                subtitle: formatLevel(track?.level),
              };
              const trackLiveSession = findJoinableLiveSession(scopedRealtimeSessions, track.id);
              const hasApprovedAccess =
                isCourseClassroom ||
                Boolean(track.is_enrolled) ||
                String(track.enrollment_status || "").toLowerCase() === "approved";
              return (
                <LiveTrackTile
                  key={track.id}
                  track={track}
                  monthLabel={monthMeta.label}
                  levelLabel={
                    monthByLevel[levelKey]
                      ? `${formatLevel(track.level)} · ${monthMeta.subtitle}`
                      : track?.level
                        ? formatLevel(track.level)
                        : ""
                  }
                  hasApprovedAccess={hasApprovedAccess}
                  liveSession={trackLiveSession}
                  joining={liveJoinState.loading}
                  onJoin={handleJoinLiveClass}
                  scheduleSummary={scheduleSummary}
                  nextClassLabel={nextClassLabel}
                  priceLabel={formatLiveClassPrice(track.price)}
                />
              );
            })}
          </div>
        ) : !error ? (
          <EmptyState icon={Video} text="No live classes are linked to this course yet." />
        ) : null}
      </section>
    </div>
  );
}
