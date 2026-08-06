import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import PageShell from "../components/PageShell";
import Button from "../components/Button";
import LiveClassViewingStage from "../components/realtime/LiveClassViewingStage";
import { getCourse, listLiveClasses } from "../api/courses";
import { joinRealtimeSession, listRealtimeSessions } from "../api/realtime";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";
import {
  findJoinableLiveSession,
  isJoinableLiveSession,
  resolveLiveClassSchedule,
} from "../utils/liveClassSchedule";

const pageBackgroundImage =
  "https://i.pinimg.com/1200x/54/57/f0/5457f05bea206d3aeccf6749065d453b.jpg";

const classSchedule = {
  days: ["Friday", "Saturday", "Sunday"],
  time: "7:00 PM to 8:00 PM IST",
  duration: "1 hour each class",
};

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

function isOsintCourse(course) {
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
  }, [isCourseClassroom, scopedCourseId]);

  useEffect(() => {
    let active = true;
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
  }, [isCourseClassroom, scopedCourseId]);

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
        setRealtimeSessions(Array.isArray(rows) ? rows.filter((item) => item.status !== "ended") : []);
      } catch {
        if (active) setRealtimeSessions([]);
      }
    };
    loadRealtimeSessions();
    const refreshId = window.setInterval(loadRealtimeSessions, 30_000);
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
    const latestActiveSession = scopedRealtimeSessions.find(
      (session) => session.id === activeLivePayload?.session?.id
    );
    if (
      activeLivePayload &&
      (!latestActiveSession || !isJoinableLiveSession(latestActiveSession))
    ) {
      setActiveLivePayload(null);
    }
  }, [activeLivePayload, scopedRealtimeSessions]);

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

  if (courseLoading) {
    return (
      <PageShell title="Live Classroom" subtitle="Loading your approved course classroom.">
        <div className="rounded-2xl border border-white/10 bg-[#0D0D0D] p-6 text-sm text-[#BDBDBD]">
          Loading classroom...
        </div>
      </PageShell>
    );
  }

  if (isCourseClassroom && (courseError || !course)) {
    return (
      <PageShell title="Live Classroom" subtitle="This course classroom could not be opened.">
        <div className="rounded-2xl border border-red-300/20 bg-red-950/20 p-6">
          <p className="text-sm text-red-200">{courseError || "Course not found."}</p>
          <Link
            to={`/courses/${scopedCourseId}`}
            className="mt-4 inline-flex rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white"
          >
            Back to course
          </Link>
        </div>
      </PageShell>
    );
  }

  if (isCourseClassroom && !hasApprovedCourseAccess(course)) {
    return (
      <PageShell
        title="Live Classroom"
        subtitle="Live classes are included with approved course access."
      >
        <div className="rounded-2xl border border-white/10 bg-[#0D0D0D] p-6">
          <p className="text-sm leading-6 text-[#BDBDBD]">
            Your account does not currently have approved access to this course.
          </p>
          <Link
            to={`/courses/${scopedCourseId}`}
            className="mt-4 inline-flex rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black"
          >
            View course access
          </Link>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={isCourseClassroom ? `${course.title} Live Classroom` : "Live Classes"}
      subtitle={
        isCourseClassroom
          ? "Your approved course classroom, live player, and weekend schedule in one place."
          : "Weekend live OSINT classes with a structured month-by-month progression."
      }
      decryptTitle
    >
      <section className="relative mb-5 overflow-hidden rounded-[20px] border border-black bg-[#080808] shadow-[0_18px_50px_rgba(0,0,0,0.32)] sm:mb-6 sm:rounded-[30px] sm:shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.16]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-black/78 to-[#111111]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(192,192,192,0.12),transparent_36%)]" />
        </div>

        <div className="relative grid gap-4 p-4 sm:gap-5 sm:p-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DBDBDB]">
              WEEKEND LIVE CLASSES
            </div>
            <h2 className="mt-4 max-w-3xl font-reference text-2xl font-semibold leading-tight text-white sm:text-3xl lg:text-[2.2rem]">
              {isCourseClassroom ? course.title : "OSINT Live Program (Month 1 to Month 3)"}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#BBBBBB]">
              {isCourseClassroom
                ? "Your approved course access includes the linked instructor-led classroom below. When no session is live, the player shows the next scheduled class."
                : "These are live classes, not self-paced course sessions. The OSINT track is delivered as a progressive 3-month path: Beginner, Intermediate, and Advanced."}
            </p>

            <div className="mt-5 grid grid-cols-1 gap-2 min-[390px]:grid-cols-3 sm:auto-rows-fr sm:gap-3">
              <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Class Days</div>
                <div className="mt-1 text-sm font-semibold text-white">{classSchedule.days.join(", ")}</div>
              </div>
              <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Duration</div>
                <div className="mt-1 text-sm font-semibold text-white">{classSchedule.duration}</div>
              </div>
              <div className="h-full rounded-2xl border border-black panel-gradient p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Track Length</div>
                <div className="mt-1 text-sm font-semibold text-white">3 Months (OSINT)</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-[#111111] p-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Classroom access
            </div>
            <h3 className="mt-3 font-reference text-2xl font-semibold text-white">
              One page for schedule and playback
            </h3>
            <p className="mt-3 text-sm leading-7 text-[#999999]">
              Approved students watch the active class directly below. When the classroom is
              offline, the same player shows the next weekend schedule.
            </p>
            <div className="mt-5 rounded-xl border border-white/10 bg-black/35 px-4 py-3 text-sm font-semibold text-[#D7D7D7]">
              Friday, Saturday and Sunday - 7:00 PM to 8:00 PM IST
            </div>
          </div>
        </div>
      </section>

      <section
        ref={liveStageRef}
        className="mb-7 scroll-mt-24 rounded-[26px] border border-white/10 bg-[#0D0D0D] p-3 sm:p-5"
      >
        <LiveClassViewingStage
          schedule={liveSchedule}
          liveSession={activeLiveSession}
          activePayload={activeLivePayload}
          joining={liveJoinState.loading}
          error={liveJoinState.error}
          legacyHref={legacyLiveHref}
          onJoin={handleJoinLiveClass}
          onLeave={() => {
            setActiveLivePayload(null);
            setLiveJoinState({ loading: false, error: "" });
          }}
        />
      </section>

      {error ? (
        <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      ) : null}

      <section className="rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
        <div className="mb-4 flex flex-col items-start gap-2 min-[430px]:flex-row min-[430px]:items-end min-[430px]:justify-between">
          <div>
            <h3 className="font-reference text-lg font-semibold text-white">
              {isCourseClassroom ? "Included Live Classes" : "OSINT Month-Wise Live Classes"}
            </h3>
            <p className="mt-1 text-xs text-[#949494]">
              Month 1 (Beginner), Month 2 (Intermediate), Month 3 (Advanced)
            </p>
          </div>
          <span className="text-xs text-[#949494]">
            {loading ? "Loading..." : `${orderedTracks.length} live track${orderedTracks.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="grid auto-rows-fr gap-5 lg:grid-cols-3">
          {orderedTracks.map((course) => {
            const levelKey = String(course?.level || "").toLowerCase();
            const monthMeta = monthByLevel[levelKey] || {
              month: 0,
              label: "Month",
              subtitle: formatLevel(course?.level),
            };
            const courseLiveSession = findJoinableLiveSession(
              scopedRealtimeSessions,
              course.id
            );
            const hasApprovedAccess =
              isCourseClassroom ||
              course.is_enrolled ||
              String(course.enrollment_status || "").toLowerCase() === "approved";
            return (
              <article
                key={course.id}
                className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-black panel-gradient p-4 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(192,192,192,0.07),transparent_40%)]" />
                <div className="relative flex h-full flex-1 flex-col">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-[#DADADA]/20 bg-[#1A1A1A] px-3 py-1 text-[11px] font-semibold tracking-wide text-[#D7D7D7]">
                      {monthMeta.label}
                    </span>
                    <span className="rounded-full border border-[#EFE1AF] bg-[linear-gradient(135deg,#FFFBEA_0%,#F6EAC7_55%,#E8D7A6_100%)] px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-[#1A1A1A]">
                      Live
                    </span>
                  </div>

                  <div className="mb-2 min-h-[1rem] text-[11px] font-semibold uppercase tracking-[0.14em] text-[#949494]">
                    {monthMeta.subtitle}
                  </div>
                  <h4 className="font-reference text-xl font-semibold leading-tight text-white lg:min-h-[5rem]">
                    {course.title}
                  </h4>
                  <p className="mt-3 text-sm leading-6 text-[#BBBBBB] lg:min-h-[6rem]">
                    {course.description || "OSINT live class track with guided progression."}
                  </p>

                  <div className="mt-4 grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Schedule</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">Fri / Sat / Sun</div>
                      <div className="mt-1 text-[10px] text-[#949494]">7-8 PM IST</div>
                    </div>
                    <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Duration</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {course.class_duration_minutes ? `${course.class_duration_minutes} min` : "1 hour"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-black panel-gradient px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">
                        {course.linked_course_id ? "Access" : "Price"}
                      </div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {course.linked_course_id ? "Included with course" : formatLiveClassPrice(course.price)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-semibold text-[#CACACA]">
                      {(course.enrollment_count ?? 0)} enrolled
                    </span>
                    {course.linked_course_id ? (
                      <Link
                        to={`/courses/${course.linked_course_id}`}
                        className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#CFCFCF] to-[#989898] px-4 py-2 text-sm font-semibold text-[#121212] transition hover:from-[#DBDBDB] hover:to-[#A6A6A6]"
                      >
                        Included with {course.linked_course_title || "parent course"}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center justify-center rounded-full border border-black bg-[#141414] px-4 py-2 text-sm font-semibold text-[#DBDBDB]">
                        Preview
                      </span>
                    )}
                  </div>

                  <div className="mt-auto pt-4">
                    {hasApprovedAccess && courseLiveSession ? (
                      <button
                        type="button"
                        onClick={() => handleJoinLiveClass(courseLiveSession.id)}
                        disabled={liveJoinState.loading}
                        className="w-full rounded-xl bg-red-600 px-5 py-3 text-sm font-extrabold uppercase tracking-[0.1em] text-white transition hover:bg-red-500 disabled:opacity-65"
                      >
                        {liveJoinState.loading ? "Connecting..." : "Watch Live Above"}
                      </button>
                    ) : hasApprovedAccess ? (
                      <div className="rounded-xl border border-white/10 bg-black/35 px-4 py-3 text-center">
                        <div className="text-xs font-bold uppercase tracking-[0.12em] text-[#D7D7D7]">
                          Access approved
                        </div>
                        <div className="mt-1 text-xs text-[#8F8F8F]">{classSchedule.time}</div>
                        <div className="mt-1 text-xs text-[#707070]">Friday, Saturday and Sunday</div>
                      </div>
                    ) : String(course.enrollment_status || "").toLowerCase() === "pending" ? (
                      <Button className="w-full" disabled>
                        Legacy Request Pending
                      </Button>
                    ) : course.linked_course_id ? (
                      <Link to={`/courses/${course.linked_course_id}`} className="block">
                        <Button className="w-full">Included with Course</Button>
                      </Link>
                    ) : (
                      <Button className="w-full" disabled>
                        Legacy Enrollment Required
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

    </PageShell>
  );
}
