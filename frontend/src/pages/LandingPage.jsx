import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import certificateExcellenceImage from "../assets/certificate-excellence.png";
import { getMyCourses, listCourses, listLiveClasses } from "../api/courses";
import { listRealtimeSessions } from "../api/realtime";
import BrandLogo from "../components/BrandLogo";
import Button from "../components/Button";
import StoryJourneySection from "../components/StoryJourneySection";
import { useAuth } from "../hooks/useAuth";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { apiData, apiMessage } from "../utils/api";
import { readCachedCourseCatalog, writeCachedCourseCatalog } from "../utils/courseCatalog";
import { formatINR } from "../utils/currency";
import { featuredCourse } from "../utils/featuredCourse";

const HERO_LIVE_BROADCAST_VISIBLE_POLL_MS = 45000;
const HERO_LIVE_BROADCAST_HIDDEN_POLL_MS = 180000;

const stats = [
  { value: "1000+", label: "Students trained" },
  { value: "98%", label: "Learner satisfaction" },
  { value: "6x", label: "Practical labs per module" },
  { value: "1:1", label: "Mentor support" },
];

const infoCards = [
  {
    title: "About Us",
    body: "Al syed Initiative is a cybersecurity learning platform focused on practical skills, ethical testing, and professional workflows.",
  },
  {
    title: "Courses We Provide",
    body: "OSINT, reconnaissance, attack surface mapping, and web application penetration testing training with structured methodology.",
  },
  {
    title: "Our Message",
    body: "Learn cybersecurity with clarity and discipline. Build a repeatable process, not just a list of tools.",
  },
];

const whyChoose = [
  {
    icon: "flow",
    title: "Flexible learning structure",
    body: "A clear module flow and practical checkpoints that fit self-paced or guided learning.",
  },
  {
    icon: "target",
    title: "Professional instruction style",
    body: "Methodology-first teaching that connects recon findings to real testing decisions.",
  },
  {
    icon: "stack",
    title: "Measured progress",
    body: "Track growth with structured modules, lessons, and hands-on workflow-based learning.",
  },
];

const steps = [
  {
    no: "1",
    title: "Enroll in the flagship course",
    body: "Start with OSINT for Cyber security and Web Application Penetration Testing.",
  },
  {
    no: "2",
    title: "Learn the recon workflow",
    body: "Understand target profiling, attack surface mapping, and OSINT prioritization.",
  },
  {
    no: "3",
    title: "Apply web app pentesting",
    body: "Use structured methodology to test, validate, and document findings.",
  },
];

const fallbackLandingLiveClasses = [
  {
    id: "osint-beginner-fallback",
    title: "OSINT Live Class - Month 1 (Beginner)",
    level: "beginner",
    month_number: 1,
    description:
      "Foundational OSINT training covering intelligence basics, legal boundaries, search engine intelligence, and SOCMINT fundamentals.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 1499,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
  },
  {
    id: "osint-intermediate-fallback",
    title: "OSINT Live Class - Month 2 (Intermediate)",
    level: "intermediate",
    month_number: 2,
    description:
      "Practical OSINT workflows for people research, domain intelligence, media analysis, and evidence correlation.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 2499,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
  },
  {
    id: "osint-advanced-fallback",
    title: "OSINT Live Class - Month 3 (Advanced)",
    level: "advanced",
    month_number: 3,
    description:
      "Advanced investigation workflow covering profiling, geolocation, archive analysis, and end-to-end intelligence work.",
    schedule_days: "Friday, Saturday, Sunday",
    class_duration_minutes: 60,
    price: 3999,
    enrollment_count: 0,
    is_enrolled: false,
    enrollment_status: "none",
  },
];

const levelOrder = { beginner: 1, intermediate: 2, advanced: 3 };
const categoryOrder = { osint: 1, web_pentesting: 2 };
const monthByLevel = {
  beginner: { month: 1, label: "Month 1", subtitle: "Foundation" },
  intermediate: { month: 2, label: "Month 2", subtitle: "Practical Skills" },
  advanced: { month: 3, label: "Month 3", subtitle: "Investigation & Intelligence" },
};
const cornerGlowPanelBg = "bg-[#070707]";
const cornerGlowCardBg = "bg-[#0A0A0A]";

function sortCatalogCourses(courses) {
  return [...courses].sort((a, b) => {
    const aCategory = categoryOrder[a?.category] ?? 99;
    const bCategory = categoryOrder[b?.category] ?? 99;
    if (aCategory !== bCategory) return aCategory - bCategory;

    const aLevel = levelOrder[a?.level] ?? 99;
    const bLevel = levelOrder[b?.level] ?? 99;
    if (aLevel !== bLevel) return aLevel - bLevel;

    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
}

function programBulletsForCourse(course) {
  const title = String(course?.title || "").toLowerCase();
  if (title.includes("osint") && title.includes("beginner")) {
    return ["Search operator fundamentals", "Evidence capture and source validation"];
  }
  if (title.includes("osint") && title.includes("intermediate")) {
    return ["Target profiling workflow", "Correlation and investigation notes"];
  }
  if (title.includes("osint") && title.includes("advanced")) {
    return ["Advanced collection planning", "Validation and reporting workflow"];
  }
  if (title.includes("web application pentesting") && title.includes("beginner")) {
    return ["Fundamentals and testing setup", "Beginner methodology track (coming soon)"];
  }
  if (title.includes("web application pentesting") && title.includes("intermediate")) {
    return ["Recon and auth testing flow", "Intermediate workflow track (coming soon)"];
  }
  if (title.includes("web application pentesting") && title.includes("advanced")) {
    return ["Advanced testing scenarios", "Reporting and validation track (coming soon)"];
  }
  return ["Structured learning path", "Practical workflow-based progression"];
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

function selectHeroLiveBroadcast(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return (
    [...rows]
      .filter((session) => {
        if (String(session?.session_type || "").trim().toLowerCase() !== "broadcasting") {
          return false;
        }
        if (String(session?.status || "").trim().toLowerCase() === "ended") {
          return false;
        }
        return String(session?.stream_status || "").trim().toLowerCase() === "live";
      })
      .sort((a, b) => {
        const aTimestamp = new Date(a?.started_at || a?.created_at || 0).getTime();
        const bTimestamp = new Date(b?.started_at || b?.created_at || 0).getTime();
        return bTimestamp - aTimestamp;
      })[0] || null
  );
}

function toValidCourseId(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function IconBadge({ type }) {
  if (type === "target") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      </svg>
    );
  }

  if (type === "stack") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
        <rect x="5" y="5" width="14" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M9 8.5v7M12 7.5v9M15 8.5v7"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5">
      <path
        d="M6 8h12M6 12h8M6 16h10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="18" cy="12" r="2" fill="currentColor" />
    </svg>
  );
}

function SectionCard({ children, className = "" }) {
  return (
    <section
      className={`relative mx-auto max-w-6xl overflow-hidden rounded-[22px] border border-white/10 ${cornerGlowPanelBg} p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-7 ${className}`}
    >
      <div className="relative z-10">{children}</div>
    </section>
  );
}

function SectionTitle({ title, subtitle, titleClassName = "" }) {
  return (
    <div className="max-w-3xl">
      <div className="mb-4 flex items-center gap-3" aria-hidden="true">
        <span className="h-px w-10 bg-white/70" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#8E8E8E]">
          Al Syed Initiative
        </span>
      </div>
      <h2
        className={`font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl ${titleClassName}`}
      >
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-3 max-w-2xl text-sm leading-7 text-[#A7A7A7] sm:text-base">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

function DashboardArrow({ className = "" }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`h-4 w-4 fill-none stroke-current ${className}`}
    >
      <path d="M4 10h11M11 6l4 4-4 4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StudentAccessPanel({
  courses,
  liveClasses,
  loading,
  error,
}) {
  const visibleCourses = courses.slice(0, 2);
  const visibleLiveClasses = liveClasses.slice(0, 2);

  return (
    <div className="rounded-[20px] border border-white/15 bg-[#242424] p-3 shadow-[0_20px_60px_rgba(0,0,0,0.5)] sm:rounded-[24px] sm:p-5 sm:shadow-[0_28px_90px_rgba(0,0,0,0.55)]">
      <div className="relative overflow-hidden rounded-[14px] border border-white/10 bg-[#141414] p-4 sm:rounded-[16px] sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7E7E7E]">
            Your workspace
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#BDBDBD]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#BDBDBD]" />
            Active
          </span>
        </div>
        <p className="mt-4 text-base font-semibold text-white sm:mt-5 sm:text-lg">Your approved learning</p>
        <p className="mt-2 text-sm leading-6 text-[#858585]">
          {loading
            ? "Loading your permissions..."
            : `${courses.length} ${courses.length === 1 ? "course" : "courses"} and ${liveClasses.length} live ${liveClasses.length === 1 ? "class" : "classes"} available.`}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
        <Link
          to="/courses?view=owned"
          className="group min-w-0 rounded-[16px] border border-white/10 bg-[#171717] p-4 transition duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-[#1D1D1D] hover:shadow-[0_14px_30px_rgba(0,0,0,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white">Courses</span>
            <div className="flex items-center gap-2 text-[#BDBDBD] transition group-hover:text-white">
              <span className="font-reference text-xs font-semibold">
                {loading ? "--" : String(courses.length).padStart(2, "0")}
              </span>
              <DashboardArrow />
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {!loading && visibleCourses.length ? visibleCourses.map((course) => (
              <p
                key={course.id}
                className="truncate text-xs font-medium text-[#D8D8D8]"
                title={course.title}
              >
                {course.title}
              </p>
            )) : (
              <p className="text-[11px] leading-5 text-[#777777]">
                {loading ? "Checking access..." : "No approved courses yet."}
              </p>
            )}
            {courses.length > visibleCourses.length ? (
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8D8D8D] group-hover:text-[#CFCFCF]">
                +{courses.length - visibleCourses.length} more
              </span>
            ) : null}
          </div>
          <span className="mt-4 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8D8D8D] transition group-hover:text-white">
            Open courses <DashboardArrow />
          </span>
        </Link>

        <Link
          to="/courses?view=owned"
          className="group min-w-0 rounded-[16px] border border-white/10 bg-[#171717] p-4 transition duration-200 hover:-translate-y-0.5 hover:border-white/30 hover:bg-[#1D1D1D] hover:shadow-[0_14px_30px_rgba(0,0,0,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white">Live classes</span>
            <div className="flex items-center gap-2 text-[#BDBDBD] transition group-hover:text-white">
              <span className="font-reference text-xs font-semibold">
                {String(liveClasses.length).padStart(2, "0")}
              </span>
              <DashboardArrow />
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {visibleLiveClasses.length ? visibleLiveClasses.map((liveClass) => (
              <p
                key={liveClass.id}
                className="truncate text-xs font-medium text-[#D8D8D8]"
                title={liveClass.title}
              >
                {liveClass.title}
              </p>
            )) : (
              <p className="text-[11px] leading-5 text-[#777777]">No approved live classes yet.</p>
            )}
            {liveClasses.length > visibleLiveClasses.length ? (
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8D8D8D] group-hover:text-[#CFCFCF]">
                +{liveClasses.length - visibleLiveClasses.length} more
              </span>
            ) : null}
          </div>
          <span className="mt-4 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8D8D8D] transition group-hover:text-white">
            Open live classes <DashboardArrow />
          </span>
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
        <Link to="/courses?view=owned" className="group inline-flex items-center justify-center gap-2 rounded-[14px] border border-white bg-white px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-black transition hover:bg-[#E7E7E7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          My courses <DashboardArrow className="transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link to="/courses?view=owned" className="group inline-flex items-center justify-center gap-2 rounded-[14px] border border-white/15 bg-[#171717] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white transition hover:border-white/35 hover:bg-[#222222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          Live classes <DashboardArrow className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      {error ? <p className="mt-3 text-xs text-red-300">{error}</p> : null}
    </div>
  );
}

function GuestAccessPanel({ courses, liveClasses, liveClassesError }) {
  const visibleCourses = courses.slice(0, 2);
  const visibleLiveClasses = liveClasses.slice(0, 2);

  return (
    <div className="rounded-[24px] border border-white/15 bg-[#242424] p-4 shadow-[0_28px_90px_rgba(0,0,0,0.55)] sm:p-5">
      <div className="relative overflow-hidden rounded-[14px] border border-white/10 bg-[#141414] p-4 sm:rounded-[16px] sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#7E7E7E]">Available learning</span>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#AFAFAF]">Catalog</span>
        </div>
        <p className="mt-5 text-lg font-semibold text-white">Explore current programs</p>
        <p className="mt-2 text-sm leading-6 text-[#858585]">
          {courses.length} {courses.length === 1 ? "course" : "courses"} and {liveClasses.length} live {liveClasses.length === 1 ? "class" : "classes"} currently listed.
        </p>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
        <div className="min-w-0 rounded-[16px] border border-white/10 bg-[#171717] p-4 transition hover:border-white/30 hover:bg-[#1D1D1D]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white">Courses</span>
            <span className="font-reference text-xs font-semibold text-[#BDBDBD]">{String(courses.length).padStart(2, "0")}</span>
          </div>
          <div className="mt-3 space-y-2">
            {visibleCourses.length ? visibleCourses.map((course) => (
              <Link
                key={course.id}
                to={`/courses/${course.id}`}
                className="group flex min-w-0 items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 text-xs font-medium text-[#D8D8D8] transition hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
                title={course.title}
              >
                <span className="truncate">{course.title}</span>
                <DashboardArrow className="shrink-0 text-[#777777] transition group-hover:translate-x-0.5 group-hover:text-white" />
              </Link>
            )) : <p className="text-[11px] leading-5 text-[#777777]">No courses are currently listed.</p>}
          </div>
        </div>

        <div className="min-w-0 rounded-[16px] border border-white/10 bg-[#171717] p-4 transition hover:border-white/30 hover:bg-[#1D1D1D]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-white">Live classes</span>
            <span className="font-reference text-xs font-semibold text-[#BDBDBD]">{String(liveClasses.length).padStart(2, "0")}</span>
          </div>
          <div className="mt-3 space-y-2">
            {visibleLiveClasses.length ? visibleLiveClasses.map((liveClass) => (
              <Link
                key={liveClass.id}
                to="/login"
                className="group flex min-w-0 items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 text-xs font-medium text-[#D8D8D8] transition hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
                title={liveClass.title}
              >
                <span className="truncate">{liveClass.title}</span>
                <DashboardArrow className="shrink-0 text-[#777777] transition group-hover:translate-x-0.5 group-hover:text-white" />
              </Link>
            )) : (
              <p className="text-[11px] leading-5 text-[#777777]">
                {liveClassesError ? "Live classes are temporarily unavailable." : "No live classes are currently listed."}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 min-[440px]:grid-cols-2">
        <Link to="/courses" className="group inline-flex items-center justify-center gap-2 rounded-[14px] border border-white bg-white px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-black transition hover:bg-[#E7E7E7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          View courses <DashboardArrow className="transition-transform group-hover:translate-x-0.5" />
        </Link>
        <Link to="/login" className="group inline-flex items-center justify-center gap-2 rounded-[14px] border border-white/15 bg-[#171717] px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-white transition hover:border-white/35 hover:bg-[#222222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70">
          Sign in for live <DashboardArrow className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { isAuthenticated } = useAuth();
  const [catalogCourses, setCatalogCourses] = useState([]);
  const [studentCourses, setStudentCourses] = useState([]);
  const [studentAccessLoading, setStudentAccessLoading] = useState(false);
  const [studentAccessError, setStudentAccessError] = useState("");
  const [landingLiveClasses, setLandingLiveClasses] = useState([]);
  const [landingLiveClassesError, setLandingLiveClassesError] = useState("");
  const [heroLiveBroadcast, setHeroLiveBroadcast] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listCourses();
        if (!active) return;
        const apiCourses = Array.isArray(apiData(response, [])) ? apiData(response, []) : [];
        writeCachedCourseCatalog(apiCourses);
        setCatalogCourses(sortCatalogCourses(apiCourses));
      } catch {
        if (!active) return;
        setCatalogCourses(sortCatalogCourses(readCachedCourseCatalog()));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    if (!isAuthenticated) {
      setStudentCourses([]);
      setStudentAccessLoading(false);
      setStudentAccessError("");
      return () => {
        active = false;
      };
    }

    setStudentAccessLoading(true);
    setStudentAccessError("");

    (async () => {
      try {
        const response = await getMyCourses();
        if (!active) return;
        const courses = apiData(response, []);
        setStudentCourses(Array.isArray(courses) ? courses : []);
      } catch (err) {
        if (!active) return;
        setStudentAccessError(apiMessage(err, "Unable to load your approved access."));
        setStudentCourses([]);
      } finally {
        if (active) setStudentAccessLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  useEffect(() => {
    let active = true;
    let timeoutId = null;
    let inFlight = false;

    if (!isAuthenticated) {
      setHeroLiveBroadcast(null);
      return undefined;
    }

    const scheduleNextPoll = () => {
      if (!active) return;
      const delay =
        document.visibilityState === "visible"
          ? HERO_LIVE_BROADCAST_VISIBLE_POLL_MS
          : HERO_LIVE_BROADCAST_HIDDEN_POLL_MS;
      timeoutId = window.setTimeout(loadHeroLiveBroadcast, delay);
    };

    const loadHeroLiveBroadcast = async () => {
      if (!active || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const response = await listRealtimeSessions({ session_type: "broadcasting", status: "all" });
        if (!active) return;
        setHeroLiveBroadcast(selectHeroLiveBroadcast(apiData(response, [])));
      } catch {
        if (!active) return;
        setHeroLiveBroadcast(null);
      } finally {
        inFlight = false;
        if (timeoutId) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }
        scheduleNextPoll();
      }
    };

    const triggerImmediateRefresh = () => {
      if (!active) return;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
      loadHeroLiveBroadcast();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        triggerImmediateRefresh();
      }
    };

    loadHeroLiveBroadcast();

    window.addEventListener("focus", triggerImmediateRefresh);
    window.addEventListener("pageshow", triggerImmediateRefresh);
    window.addEventListener("online", triggerImmediateRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", triggerImmediateRefresh);
      window.removeEventListener("pageshow", triggerImmediateRefresh);
      window.removeEventListener("online", triggerImmediateRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listLiveClasses();
        if (!active) return;
        const liveClasses = apiData(response, []);
        setLandingLiveClasses(liveClasses.length ? liveClasses : fallbackLandingLiveClasses);
        setLandingLiveClassesError("");
      } catch {
        if (!active) return;
        setLandingLiveClasses(fallbackLandingLiveClasses);
        setLandingLiveClassesError(
          "Showing local live classes preview while the live class feed is unavailable."
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const featuredLiveCourse = useMemo(() => {
    const liveCourses = catalogCourses.filter(
      (course) => getCourseLaunchStatus(course).isLive
    );
    return (
      liveCourses.find((course) =>
        String(course.title || "").toLowerCase().includes("osint beginner")
      ) ||
      liveCourses[0] ||
      catalogCourses[0] ||
      featuredCourse
    );
  }, [catalogCourses]);

  const featuredLiveCourseLink = featuredLiveCourse?._fallbackLink || `/courses/${featuredLiveCourse.id}`;
  const heroLiveBroadcastCourseId = Number(
    heroLiveBroadcast?.linked_course?.id
      || heroLiveBroadcast?.linked_live_class?.linked_course_id
      || 0
  );
  const heroLiveBroadcastJoinPath = heroLiveBroadcast
    ? heroLiveBroadcastCourseId > 0
      ? `/courses/${heroLiveBroadcastCourseId}/live?session=${heroLiveBroadcast.id}`
      : `/join-live?session=${heroLiveBroadcast.id}`
    : "/courses?view=owned";

  const landingLiveCourses = useMemo(() => {
    return catalogCourses.filter((course) => getCourseLaunchStatus(course).isLive);
  }, [catalogCourses]);

  const landingPrograms = useMemo(() => {
    return [...landingLiveClasses].sort((a, b) => {
      const aLevel = levelOrder[String(a?.level || "").toLowerCase()] || a?.month_number || 99;
      const bLevel = levelOrder[String(b?.level || "").toLowerCase()] || b?.month_number || 99;
      if (aLevel !== bLevel) return aLevel - bLevel;
      return String(a?.title || "").localeCompare(String(b?.title || ""));
    });
  }, [landingLiveClasses]);

  const approvedLiveClasses = useMemo(() => {
    return landingPrograms.filter((program) => {
      const status = String(program?.enrollment_status || "").toLowerCase();
      return Boolean(program?.is_enrolled) || status === "approved";
    });
  }, [landingPrograms]);

  return (
    <div className="relative bg-[#030303] text-[#F6F6F6]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[linear-gradient(180deg,#020202_0%,#050505_52%,#030303_100%)]" />
        <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] [background-size:72px_72px]" />
      </div>

      <section
        className="landing-hero relative z-10 overflow-hidden border-b border-white/10 bg-black px-4"
      >
        <div className="relative mx-auto grid min-h-[calc(100dvh-4rem)] max-w-6xl items-center gap-10 py-12 sm:min-h-[620px] sm:py-20 lg:grid-cols-[0.96fr_1.04fr] lg:gap-20 lg:py-24">
          <div className="reveal-up">
            <div className="flex items-center gap-4">
              <span className="h-px w-10 bg-white/70" aria-hidden="true" />
              <BrandLogo className="shrink-0" />
            </div>

            {heroLiveBroadcast ? (
              <div className="ml-2 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#BDBDBD]">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                Live now
              </div>
            ) : null}

            <h1 className="mt-6 max-w-[660px] font-reference text-[clamp(2.35rem,11vw,4.25rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-white sm:mt-7 sm:text-[clamp(2.75rem,4.5vw,4.25rem)]">
              Learn practical skills through clean, focused courses.
            </h1>

            <p className="mt-6 max-w-xl text-sm leading-7 text-[#8E8E8E] sm:text-base">
              A focused learning platform for OSINT, reconnaissance, web application testing,
              protected lessons, and instructor-led live classes.
            </p>

            {heroLiveBroadcast ? (
              <Link
                to={isAuthenticated ? heroLiveBroadcastJoinPath : "/login"}
                className="mt-7 flex w-full max-w-xl items-center justify-between gap-4 rounded-xl border border-red-400/45 bg-red-600 px-5 py-4 text-left text-white shadow-[0_20px_48px_rgba(220,38,38,0.3)] transition hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
              >
                <span>
                  <span className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.2em] text-red-100">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white shadow-[0_0_18px_rgba(255,255,255,0.95)]" />
                    Class is live
                  </span>
                  <span className="mt-1 block text-base font-extrabold sm:text-lg">
                    {heroLiveBroadcast.title || "Join your live classroom"}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-extrabold uppercase tracking-[0.1em]">
                  Join now -&gt;
                </span>
              </Link>
            ) : null}

            <div className="mt-7 flex flex-wrap gap-3">
              <Link
                to="/courses"
                className="inline-flex min-h-11 items-center justify-center rounded-lg bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E5E5E5]"
              >
                Browse Courses
              </Link>
              <Link
                to={isAuthenticated ? "/courses?view=owned" : "/login"}
                className="inline-flex min-h-11 items-center justify-center rounded-lg border border-white/15 bg-[#090909] px-5 text-sm font-semibold text-white transition hover:border-white/25 hover:bg-[#111111]"
              >
                {isAuthenticated ? "My Learning" : "Get Started"}
              </Link>
            </div>
          </div>

          <div className="reveal-up reveal-delay-1 relative">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-12 -top-8 -z-10 h-72 w-72 rounded-full bg-white/[0.08] blur-[96px] sm:-right-16 sm:h-80 sm:w-80"
            />
            {isAuthenticated ? (
              <StudentAccessPanel
                courses={studentCourses}
                liveClasses={approvedLiveClasses}
                loading={studentAccessLoading}
                error={studentAccessError}
              />
            ) : (
              <GuestAccessPanel
                courses={catalogCourses}
                liveClasses={landingLiveClassesError ? [] : landingPrograms}
                liveClassesError={landingLiveClassesError}
              />
            )}
          </div>
        </div>
      </section>

      <div className="relative z-10 px-4 pb-20 pt-2">
        <div className="mx-auto max-w-6xl space-y-8">
          <SectionCard className="!p-0">
            <div className="grid gap-0 lg:grid-cols-[0.72fr_1.28fr]">
              <div className="flex flex-col justify-center border-b border-white/10 p-5 sm:p-7 lg:border-b-0 lg:border-r lg:p-8">
                <span className="w-fit rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#AFAFAF]">
                  Certificate format
                </span>
                <h2 className="mt-5 font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Recognition designed to carry forward
                </h2>
                <p className="mt-4 text-sm leading-7 text-[#9E9E9E]">
                  Successful learners receive an ADL FRONT Certificate of Excellence in this
                  official format, recording the recipient, completion date, and authorized
                  recognition of their training achievement.
                </p>

                <dl className="mt-7 grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                  {[
                    ["Recipient", "Personalized student name"],
                    ["Recognition", "Training achievement"],
                    ["Authorization", "Official signature and issue date"],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/10 bg-[#0A0A0A] px-4 py-3">
                      <dt className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#717171]">
                        {label}
                      </dt>
                      <dd className="mt-1.5 text-xs font-semibold text-[#D4D4D4]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <figure className="flex min-w-0 items-center bg-[#0B0B0B] p-3 sm:p-5 lg:p-6">
                <div className="w-full overflow-hidden rounded-xl border border-white/15 bg-[#151515] shadow-[0_24px_70px_rgba(0,0,0,0.5)]">
                  <img
                    src={certificateExcellenceImage}
                    alt="ADL FRONT Certificate of Excellence format"
                    className="block h-auto w-full object-contain"
                    loading="lazy"
                    decoding="async"
                  />
                </div>
                <figcaption className="sr-only">
                  Official certificate format presented to successful learners.
                </figcaption>
              </figure>
            </div>
          </SectionCard>

          <div className="grid overflow-hidden rounded-[20px] border border-white/10 bg-[#070707] sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((item, idx) => (
              <div
                key={item.label}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex min-h-28 h-full flex-col justify-center border-b border-white/10 px-5 py-5 last:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0`}
              >
                <div className="font-reference text-3xl font-semibold text-white">{item.value}</div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#777777]">
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          <section id="about" className="scroll-mt-24 rounded-[22px] border border-white/10 bg-[#070707] p-5 sm:p-7">
            <SectionTitle
              title="Built for disciplined learning"
              subtitle="A focused cybersecurity education platform for students who value method, evidence, and responsible practice."
            />
            <div className="mt-7 grid auto-rows-fr gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:grid-cols-3">
            {infoCards.map((card, idx) => (
              <div
                key={card.title}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex h-full flex-col bg-[#090909] p-5 sm:p-6`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#AFAFAF]">0{idx + 1}</span>
                <h3 className="mt-4 font-reference text-xl font-semibold text-white">{card.title}</h3>
                <p className="mt-3 text-sm leading-7 text-[#9E9E9E]">{card.body}</p>
              </div>
            ))}
            </div>
          </section>

          <StoryJourneySection className="reveal-up reveal-delay-1" />

          <SectionCard>
            <SectionTitle
              title="Why learners choose Al syed Initiative"
              subtitle="Cybersecurity training depth with a modern online learning experience focused on professional execution."
            />
            <div className="mt-6 grid auto-rows-fr gap-4 lg:grid-cols-3">
              {whyChoose.map((item, idx) => (
                <div
                  key={item.title}
                  className={`hover-lift reveal-up ${
                    idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col rounded-2xl border border-white/10 bg-[#0A0A0A] p-5`}
                >
                  <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-[#050505] text-[#CFCFCF]">
                    <IconBadge type={item.icon} />
                  </div>
                  <h3 className="font-reference text-xl font-semibold leading-tight text-white">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-sm leading-7 text-[#999999]">{item.body}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard>
            <SectionTitle
              title="How your journey works"
              subtitle="A simple onboarding path into structured cybersecurity learning and hands-on practice."
            />
            <div className="mt-6 grid auto-rows-fr gap-4 lg:grid-cols-3">
              {steps.map((step, idx) => (
                <div
                  key={step.no}
                  className={`hover-lift reveal-up ${
                    idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col border-t border-white/10 px-1 py-5`}
                >
                  <div className="mb-5 flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-white/[0.06] text-xs font-bold text-white">
                    {step.no}
                  </div>
                  <h3 className="font-reference text-lg font-semibold tracking-tight text-white">{step.title}</h3>
                  <p className="mt-2 text-sm leading-7 text-[#999999]">{step.body}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard className="p-5 sm:p-6">
            <SectionTitle
              title="Live courses"
              subtitle="Explore courses that are currently open for enrollment."
            />

            {landingLiveCourses.length ? (
              <div className="mt-6 grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
                {landingLiveCourses.map((course, idx) => {
                  return (
                    <article
                      key={course.id}
                      className={`hover-lift reveal-up ${
                        idx % 3 === 0
                          ? "reveal-delay-1"
                          : idx % 3 === 1
                            ? "reveal-delay-2"
                            : "reveal-delay-3"
                      } flex h-full flex-col rounded-2xl border border-white/10 ${cornerGlowCardBg} p-5 transition-colors hover:border-white/20`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="rounded-full border border-white/10 bg-[#050505] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A8A8A8]">
                          {formatLevel(course.level)}
                        </span>
                        <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                          Live
                        </span>
                      </div>

                      <h3 className="mt-4 font-reference text-2xl font-semibold leading-tight text-white">
                        {course.title}
                      </h3>
                      <p className="mt-3 line-clamp-4 text-sm leading-6 text-[#BBBBBB]">
                        {course.description || "Structured cybersecurity course with guided progression."}
                      </p>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">
                            Modules
                          </div>
                          <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                            {course.section_count ?? 0}
                          </div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                          <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">
                            Price
                          </div>
                          <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                            {formatINR(course.price)}
                          </div>
                        </div>
                      </div>

                      <div className="mt-auto grid grid-cols-2 gap-2 pt-5">
                        <Link
                          to={course?._fallbackLink || `/courses/${course.id}`}
                          className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5 text-sm font-semibold text-[#D8D8D8] transition hover:border-white/20 hover:bg-[#101010]"
                        >
                          View Details
                        </Link>
                        {isAuthenticated ? (
                          <Link
                            to={course?._fallbackLink || `/courses/${course.id}`}
                            className="inline-flex items-center justify-center rounded-xl border border-white bg-white px-3 py-2.5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8]"
                          >
                            Open Course
                          </Link>
                        ) : (
                          <Link
                            to={course?._fallbackLink || `/courses/${course.id}`}
                            className="inline-flex items-center justify-center rounded-xl border border-white bg-white px-3 py-2.5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8]"
                          >
                            View Course
                          </Link>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="mt-6 rounded-xl border border-white/10 bg-[#090909] px-4 py-3 text-sm text-[#AAAAAA]">
                Live courses are being updated. Submit an enrollment enquiry and our team will contact you.
              </p>
            )}
          </SectionCard>

          <SectionCard className="p-5 sm:p-6">
            <SectionTitle
              title="Live classes"
              subtitle="Browse our current live OSINT classes and enroll directly from the landing page."
            />

            {landingLiveClassesError ? (
              <div className="mt-6 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
                {landingLiveClassesError}
              </div>
            ) : null}

            <div className="mt-6 grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
              {landingPrograms.map((program, idx) => {
                const levelKey = String(program?.level || "").toLowerCase();
                const monthMeta = monthByLevel[levelKey] || {
                  month: program?.month_number || 0,
                  label: `Month ${program?.month_number || ""}`.trim(),
                  subtitle: formatLevel(program?.level),
                };
                const enrollmentStatus = String(program.enrollment_status || "").toLowerCase();
                const detailsLink = "/live-classes";
                return (
                <div
                  key={program.id}
                  className={`hover-lift reveal-up ${
                    idx % 3 === 0 ? "reveal-delay-1" : idx % 3 === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col rounded-2xl border border-white/10 ${cornerGlowCardBg} p-5 transition-colors hover:border-white/20`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full border border-white/10 bg-[#050505] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#A8A8A8]">
                      {monthMeta.label || `Live Class ${idx + 1}`}
                    </span>
                    <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                      Live
                    </span>
                  </div>

                  <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#949494]">
                    {monthMeta.subtitle}
                  </div>

                  <h3 className="mt-4 font-reference text-2xl font-semibold leading-tight text-white">
                    {program.title}
                  </h3>

                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                    {program.description || "OSINT live class track with guided progression."}
                  </p>

                  <div className="mt-4 grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Schedule</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.schedule_days || "Fri / Sat / Sun"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Duration</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.class_duration_minutes
                          ? `${program.class_duration_minutes} min`
                          : "1 hour"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Price</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {formatLiveClassPrice(program.price)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-white/10 bg-[#060606] px-3 py-1 text-xs font-semibold text-[#AAAAAA]">
                      {(program.enrollment_count ?? 0)} enrolled
                    </span>
                    <Link
                      to={detailsLink}
                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-[#060606] px-4 py-2 text-sm font-semibold text-[#D8D8D8] transition hover:border-white/20 hover:bg-[#101010]"
                    >
                      View Details
                    </Link>
                  </div>

                  <div className="mt-auto pt-4">
                    {program.is_enrolled || enrollmentStatus === "approved" ? (
                      <Button className="w-full" disabled>
                        Access Approved
                      </Button>
                    ) : enrollmentStatus === "pending" ? (
                      <Button className="w-full" disabled>
                        Legacy Request Pending
                      </Button>
                    ) : program.linked_course_id ? (
                      <Link to={`/courses/${program.linked_course_id}`} className="block">
                        <Button className="w-full">Buy Linked Course</Button>
                      </Link>
                    ) : (
                      <Button className="w-full" disabled>
                        Included With Course
                      </Button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            <div className="mt-7 rounded-2xl border border-white/10 bg-[#090909] p-5 text-white sm:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="font-reference text-2xl font-semibold">
                    Ready to start your cybersecurity journey?
                  </h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[#A8A8A8]">
                    Join our flagship course and learn OSINT plus web application pentesting with a structured workflow.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/courses"
                  >
                    <button className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/5">
                      Explore
                    </button>
                  </Link>
                  <Link
                    to={featuredLiveCourseLink}
                  >
                    <button className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-[#E8E8E8]">
                      Join Now
                    </button>
                  </Link>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>

    </div>
  );
}




