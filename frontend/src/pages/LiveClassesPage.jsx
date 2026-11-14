import "../features/live-classes/LiveClasses.scss";

import { ArrowLeft, ArrowRight, Locked, Video } from "@carbon/icons-react";
import { Button, SkeletonPlaceholder, SkeletonText } from "@carbon/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getCourse, listLiveClasses } from "../api/courses";
import { getRealtimeSession, joinRealtimeSession } from "../api/realtime";
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
  missingActiveSessionId,
  reconcileActiveLivePayload,
} from "../utils/realtimeSessionResilience";
import { useLiveSessions } from "../services/realtime/liveSessionsStore";
import useLivePresence from "../features/engagement-ui/useLivePresence";
import useAttendancePresence from "../features/attendance/useAttendancePresence";
import { liveJoinDisplayName } from "../features/profiles/publicName";

// No fabricated fallback classes (plan §7.2 rule 5): an empty list shows an
// honest empty state, a failed request an error with Try again.

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
  // One shared, visibility-aware poll of the active sessions (paused while the
  // tab is hidden; unchanged lists answer 304).
  const liveSessions = useLiveSessions({ enabled: isAuthenticated, userKey: user?.id });
  const realtimeSessions = liveSessions.sessions;
  const liveSessionsFetchedAt = liveSessions.fetchedAt;
  const absenceCheckedAtRef = useRef(0);
  const [activeLivePayload, setActiveLivePayload] = useState(null);
  // Live-attendance XP: one presence ping a minute while the class is open and visible.
  useLivePresence(activeLivePayload?.session?.id || null);
  // Attendance: once a minute while this live page is visible (live classes only).
  useAttendancePresence(activeLivePayload?.session?.id || null);
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
        setTracks(liveClasses);
        setError("");
      } catch (err) {
        if (!active) return;
        setTracks([]);
        setError(
          isCourseClassroom
            ? apiMessage(err, "Unable to load this course's live classes.")
            : apiMessage(err, "Check your connection and try again.")
        );
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [isCourseClassroom, scopedCourseId, tracksAttempt]);

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

  // The list holds active sessions only, so a class that ended simply drops
  // out of it. When the watched session is missing from a successful refresh,
  // ask for that one session (once per refresh) and close the player only if
  // it really ended or no longer exists; anything else keeps it mounted.
  useEffect(() => {
    const missingId = missingActiveSessionId(activeLivePayload, scopedRealtimeSessions);
    if (!missingId || !liveSessionsFetchedAt || absenceCheckedAtRef.current === liveSessionsFetchedAt) {
      return undefined;
    }
    absenceCheckedAtRef.current = liveSessionsFetchedAt;
    let active = true;
    const closeIfStillWatching = () => {
      setActiveLivePayload((previous) =>
        String(previous?.session?.id) === String(missingId) ? null : previous
      );
    };
    getRealtimeSession(missingId)
      .then((response) => {
        if (active && String(apiData(response, null)?.status || "").toLowerCase() === "ended") {
          closeIfStillWatching();
        }
      })
      .catch((err) => {
        if (active && err?.response?.status === 404) closeIfStillWatching();
      });
    return () => {
      active = false;
    };
  }, [activeLivePayload, liveSessionsFetchedAt, scopedRealtimeSessions]);

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
        display_name: liveJoinDisplayName(user),
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
            kind="error"
            title="Couldn't load the live classes."
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
          <EmptyState
            icon={Video}
            text={isCourseClassroom ? "No live classes are linked to this course yet." : "No live classes scheduled right now."}
          />
        ) : null}
      </section>
    </div>
  );
}
