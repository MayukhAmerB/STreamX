import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { enrollInLiveClass, listCourses, listLiveClasses } from "../api/courses";
import { listRealtimeSessions } from "../api/realtime";
import Button from "../components/Button";
import PublicEnrollmentRequestModal from "../components/PublicEnrollmentRequestModal";
import StoryJourneySection from "../components/StoryJourneySection";
import { useAuth } from "../hooks/useAuth";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { apiData, apiMessage } from "../utils/api";
import { readCachedCourseCatalog, writeCachedCourseCatalog } from "../utils/courseCatalog";
import { formatINR } from "../utils/currency";
import { featuredCourse } from "../utils/featuredCourse";

const heroCardImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";
const heroGlitchBase =
  "AL SYED INITIATIVE // CYBERSECURITY // OSINT // WEB PENTESTING // LIVE TRAINING // ";
const heroGlitchLine = `${heroGlitchBase}${heroGlitchBase}${heroGlitchBase}${heroGlitchBase}`;
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
const cornerGlowPanelBg =
  "bg-[radial-gradient(circle_at_100%_0%,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0.035)_24%,rgba(255,255,255,0)_52%),linear-gradient(130deg,#000000_74%,#111111_100%)]";
const cornerGlowCardBg =
  "bg-[radial-gradient(circle_at_100%_0%,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.028)_24%,rgba(255,255,255,0)_52%),linear-gradient(130deg,#000000_76%,#101010_100%)]";

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

function toValidLiveClassId(value) {
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
      className={`relative mx-auto max-w-6xl overflow-hidden rounded-[24px] border border-black ${cornerGlowPanelBg} p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)] sm:p-6 ${className}`}
    >
      <div className="relative z-10">{children}</div>
    </section>
  );
}

function SectionTitle({ title, subtitle, titleClassName = "" }) {
  return (
    <div className="text-center">
      <h2
        className={`font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl ${titleClassName}`}
      >
        {title}
      </h2>
      {subtitle ? (
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[#D3D3D3] sm:text-base">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export default function LandingPage() {
  const { isAuthenticated } = useAuth();
  const [catalogCourses, setCatalogCourses] = useState([]);
  const [landingLiveClasses, setLandingLiveClasses] = useState([]);
  const [landingLiveClassesError, setLandingLiveClassesError] = useState("");
  const [landingActionState, setLandingActionState] = useState({});
  const [landingPublicLeadTarget, setLandingPublicLeadTarget] = useState(null);
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
  }, []);

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
  const heroLiveBroadcastJoinPath = heroLiveBroadcast ? `/join-live?session=${heroLiveBroadcast.id}` : "/join-live";

  const landingPrograms = useMemo(() => {
    return [...landingLiveClasses].sort((a, b) => {
      const aLevel = levelOrder[String(a?.level || "").toLowerCase()] || a?.month_number || 99;
      const bLevel = levelOrder[String(b?.level || "").toLowerCase()] || b?.month_number || 99;
      if (aLevel !== bLevel) return aLevel - bLevel;
      return String(a?.title || "").localeCompare(String(b?.title || ""));
    });
  }, [landingLiveClasses]);

  const handleLandingEnroll = async (liveClassId) => {
    const targetId = toValidLiveClassId(liveClassId);
    if (!targetId) {
      setLandingActionState((prev) => ({
        ...prev,
        [liveClassId]: {
          loading: false,
          error: "Enrollment is unavailable in preview mode.",
          success: "",
        },
      }));
      return;
    }

    setLandingActionState((prev) => ({
      ...prev,
      [liveClassId]: { loading: true, error: "", success: "" },
    }));

    try {
      const response = await enrollInLiveClass({ live_class_id: targetId });
      const data = apiData(response, {});
      const enrollmentStatus = String(
        data?.enrollment_status || (data?.enrolled ? "approved" : "pending")
      ).toLowerCase();

      setLandingLiveClasses((prev) =>
        prev.map((item) =>
          item.id === liveClassId
            ? {
                ...item,
                is_enrolled: enrollmentStatus === "approved",
                enrollment_status: enrollmentStatus,
                enrollment_count:
                  enrollmentStatus === "approved" && !data.already_enrolled
                    ? (item.enrollment_count || 0) + 1
                    : item.enrollment_count || 0,
              }
            : item
        )
      );

      setLandingActionState((prev) => ({
        ...prev,
        [liveClassId]: {
          loading: false,
          error: "",
          success:
            response?.data?.message ||
            (enrollmentStatus === "approved"
              ? "Already enrolled."
              : "Enrollment request submitted for admin approval."),
        },
      }));
    } catch (err) {
      setLandingActionState((prev) => ({
        ...prev,
        [liveClassId]: {
          loading: false,
          error: apiMessage(err, "Unable to enroll."),
          success: "",
        },
      }));
    }
  };

  return (
    <div className="relative bg-transparent text-[#F6F6F6]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[radial-gradient(92%_82%_at_100%_0%,rgba(255,255,255,0.24)_0%,rgba(255,255,255,0.11)_24%,rgba(255,255,255,0.045)_42%,rgba(255,255,255,0)_68%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(0,0,0,0)_58%,rgba(255,255,255,0.02)_76%,rgba(255,255,255,0.07)_100%)]" />
      </div>

      <section className="landing-hero relative z-10 overflow-hidden px-4 pb-8 pt-6 sm:pt-10">
        <div
          aria-hidden="true"
          className="hero-glitch-ribbon absolute left-1/2 top-3 z-20 hidden w-[min(96%,1040px)] -translate-x-1/2 overflow-hidden rounded-full px-4 py-1 sm:block"
        >
          <p className="hero-glitch-ribbon-line">{heroGlitchLine}</p>
        </div>
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-black" />
          <div aria-hidden="true" className="hero-glitch-overlay absolute inset-0 overflow-hidden">
            <p className="hero-glitch-line hero-glitch-line-a">{heroGlitchLine}</p>
            <p className="hero-glitch-line hero-glitch-line-b">{heroGlitchLine}</p>
            <p className="hero-glitch-line hero-glitch-line-c">{heroGlitchLine}</p>
          </div>
          <div className="absolute inset-0 bg-[radial-gradient(88%_78%_at_100%_0%,rgba(255,255,255,0.26)_0%,rgba(255,255,255,0.12)_24%,rgba(255,255,255,0.05)_42%,rgba(255,255,255,0)_68%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(0,0,0,0)_58%,rgba(255,255,255,0.025)_76%,rgba(255,255,255,0.08)_100%)]" />
        </div>
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[30px] border border-black bg-black shadow-[0_28px_80px_rgba(0,0,0,0.42)]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1]">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_22%,rgba(255,255,255,0.10),transparent_44%)]" />
          </div>
          <div className="relative z-10 grid items-center gap-8 p-5 sm:p-7 lg:grid-cols-[1.03fr_0.97fr]">
            <div className="reveal-up">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#A2A2A2]/30 bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#DBDBDB]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#C0C0C0]" />
                Al syed Initiative Cybersecurity Platform
              </div>

              {heroLiveBroadcast ? (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-red-400/45 bg-red-500/15 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-100 shadow-[0_0_24px_rgba(220,38,38,0.18)]">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-80" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-400" />
                  </span>
                  Live Broadcast Running Now
                </div>
              ) : null}

              <h1 className="mt-5 max-w-xl font-reference text-4xl font-semibold leading-[1.02] tracking-tight text-white sm:text-5xl lg:text-6xl">
                Learn Cyber Security with Expert-Led Practical Training
              </h1>

              <p className="mt-5 max-w-xl text-sm leading-7 text-[#BBBBBB] sm:text-base">
                We teach cybersecurity through structured OSINT, reconnaissance, and web application
                penetration testing workflows. Trusted by over 1000 students building practical skills.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link to={featuredLiveCourseLink}>
                  <Button className="rounded-full bg-gradient-to-r from-[#CFCFCF] to-[#989898] px-5 text-[#121212] hover:from-[#DBDBDB] hover:to-[#A6A6A6]">
                    View Flagship Course
                  </Button>
                </Link>
                <Link to="/courses">
                  <Button
                    variant="indigoSoft"
                    className="glossy rounded-full !border-[#F4F4F4] !bg-[linear-gradient(135deg,#FEFEFE_0%,#F7F7F7_52%,#E2E2E2_100%)] px-5 !text-[#121212] shadow-[0_14px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.95)] hover:!bg-[linear-gradient(135deg,#FFFFFF_0%,#F9F9F9_52%,#E6E6E6_100%)]"
                  >
                    Explore Programs
                  </Button>
                </Link>
                {isAuthenticated && heroLiveBroadcast ? (
                  <Link to={heroLiveBroadcastJoinPath}>
                    <Button
                      variant="danger"
                      className="rounded-full border-red-400/60 bg-[linear-gradient(135deg,#ef4444_0%,#b91c1c_100%)] px-5 text-white shadow-[0_16px_34px_rgba(220,38,38,0.28)] hover:bg-[linear-gradient(135deg,#f87171_0%,#dc2626_100%)]"
                    >
                      Join Live Now
                    </Button>
                  </Link>
                ) : null}
              </div>

              <div className="mt-5 rounded-2xl border border-black bg-black/92 p-4 shadow-[0_18px_40px_rgba(0,0,0,0.22)]">
                <div className="grid gap-2 text-sm text-[#BBBBBB] sm:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#DBDBDB]" />
                    OSINT and attack surface mapping
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#DBDBDB]" />
                    Web application pentesting workflow
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#DBDBDB]" />
                    Practical lessons and structured modules
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#DBDBDB]" />
                    Ethical and professional methodology
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["OSINT", "Web App Pentesting", "Recon Workflow"].map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-semibold text-[#DBDBDB]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="reveal-up reveal-delay-1 relative">
              <div className="rounded-[28px] border border-black bg-black/92 p-3 shadow-[0_24px_60px_rgba(0,0,0,0.36)]">
                <div className="relative h-[570px] overflow-hidden rounded-[24px] border border-black bg-black sm:h-[570px]">
                  <img
                    src={heroCardImage}
                    alt="Cybersecurity training visual"
                    className="h-full w-full object-cover opacity-[0.9]"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/78 via-black/30 to-black/12" />
                  <div className="absolute left-4 top-4 rounded-2xl border border-black bg-black/86 px-4 py-3 backdrop-blur-sm">
                    <div className="font-reference text-[10px] tracking-[0.22em] text-[#949494]">
                      LIVE TRAINING
                    </div>
                    <div className="mt-2 text-lg font-semibold text-white">Structured cybersecurity learning</div>
                    <div className="mt-1 max-w-[220px] text-xs leading-5 text-[#BBBBBB]">
                      Guided modules, professional instruction, and practical workflow-based training.
                    </div>
                  </div>

                  <div className="absolute inset-x-4 bottom-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-black bg-black/88 p-3 backdrop-blur-sm">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#949494]">1000+ Students</div>
                      <div className="mt-2 text-sm font-semibold text-[#E5E5E5]">Active cybersecurity learners</div>
                    </div>
                    <div className="rounded-2xl border border-black bg-black/88 p-3 backdrop-blur-sm">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#949494]">Top-Rated Training</div>
                      <div className="mt-2 text-sm font-semibold text-[#E5E5E5]">Workflow-first progression</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="relative z-10 px-4 pb-16">
        <div className="mx-auto max-w-6xl space-y-7">
          <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((item, idx) => (
              <div
                key={item.label}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex h-full flex-col items-center justify-center rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] px-4 py-4 text-center shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
              >
                <div className="font-reference text-3xl font-semibold text-[#111111]">{item.value}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-[#2A2A2A]">
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          <div id="about" className="grid auto-rows-fr gap-3 scroll-mt-24 lg:grid-cols-3">
            {infoCards.map((card, idx) => (
              <div
                key={card.title}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex h-full flex-col rounded-2xl border border-black ${cornerGlowCardBg} p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
              >
                <h3 className="font-reference text-xl font-semibold text-white">{card.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">{card.body}</p>
              </div>
            ))}
          </div>

          <StoryJourneySection className="reveal-up reveal-delay-1" />

          <SectionCard>
            <SectionTitle
              title="Why learners choose Al syed Initiative"
              titleClassName="uppercase tracking-[0.04em] sm:tracking-[0.05em]"
              subtitle="Cybersecurity training depth with a modern online learning experience focused on professional execution."
            />
            <div className="mt-6 grid auto-rows-fr gap-4 lg:grid-cols-3">
              {whyChoose.map((item, idx) => (
                <div
                  key={item.title}
                  className={`hover-lift reveal-up ${
                    idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col rounded-2xl border border-black bg-[linear-gradient(135deg,#FFFFFF_0%,#F4F4F4_58%,#E1E1E1_100%)] p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
                >
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[#CDCDCD] bg-[#F0F0F0] text-[#2A2A2A] shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
                    <IconBadge type={item.icon} />
                  </div>
                  <h3 className="font-reference text-xl font-semibold leading-tight text-[#111111]">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#2E2E2E]">{item.body}</p>
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
                  } flex h-full flex-col rounded-2xl border border-black ${cornerGlowCardBg} p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
                >
                  <div className="mb-4 flex h-7 w-7 items-center justify-center rounded-full bg-[#A2A2A2] text-xs font-bold text-white">
                    {step.no}
                  </div>
                  <h3 className="font-reference text-base font-semibold tracking-tight text-white">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">{step.body}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard className="p-5 sm:p-6">
            <SectionTitle
              title="Popular programs"
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
                  } flex h-full flex-col rounded-2xl border border-black ${cornerGlowCardBg} p-4 shadow-[0_10px_24px_rgba(0,0,0,0.25)]`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full border border-black bg-[#111111] px-2.5 py-1 text-[11px] font-semibold text-[#D6D6D6]">
                      {monthMeta.label || `Live Class ${idx + 1}`}
                    </span>
                    <span className="rounded-full border border-[#EFE1AF] bg-[linear-gradient(135deg,#FFFBEA_0%,#F6EAC7_55%,#E8D7A6_100%)] px-2.5 py-1 text-[11px] font-semibold text-[#1A1A1A]">
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
                    <div className="h-full rounded-xl border border-black bg-[#121212] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Schedule</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.schedule_days || "Fri / Sat / Sun"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-black bg-[#121212] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Duration</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.class_duration_minutes
                          ? `${program.class_duration_minutes} min`
                          : "1 hour"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-black bg-[#121212] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Price</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {formatLiveClassPrice(program.price)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-semibold text-[#CACACA]">
                      {(program.enrollment_count ?? 0)} enrolled
                    </span>
                    <Link
                      to={detailsLink}
                      className="inline-flex items-center justify-center rounded-full border border-black bg-[#141414] px-4 py-2 text-sm font-semibold text-[#DBDBDB] transition hover:bg-[#1B1B1B]"
                    >
                      View Details
                    </Link>
                  </div>

                  <div className="mt-auto pt-4">
                    {program.is_enrolled || enrollmentStatus === "approved" ? (
                      <Button className="w-full" disabled>
                        Enrolled
                      </Button>
                    ) : enrollmentStatus === "pending" ? (
                      <Button className="w-full" disabled>
                        Pending Approval
                      </Button>
                    ) : isAuthenticated ? (
                      <Button
                        className="w-full"
                        onClick={() => handleLandingEnroll(program.id)}
                        loading={Boolean(landingActionState[program.id]?.loading)}
                      >
                        Enroll
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        onClick={() => {
                          const targetId = toValidLiveClassId(program.id);
                          if (!targetId) {
                            setLandingActionState((prev) => ({
                              ...prev,
                              [program.id]: {
                                loading: false,
                                error: "Enrollment is unavailable in preview mode.",
                                success: "",
                              },
                            }));
                            return;
                          }
                          setLandingPublicLeadTarget({
                            id: targetId,
                            title: program.title,
                          });
                        }}
                      >
                        Enroll
                      </Button>
                    )}
                    {landingActionState[program.id]?.error ? (
                      <p className="mt-2 text-xs text-red-300">{landingActionState[program.id].error}</p>
                    ) : null}
                    {landingActionState[program.id]?.success ? (
                      <p className="mt-2 text-xs text-zinc-300">
                        {landingActionState[program.id].success}
                      </p>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-2xl border border-black bg-[linear-gradient(90deg,#121212_0%,#5F5F5F_52%,#D8D8D8_100%)] p-5 text-white shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="font-reference text-2xl font-semibold">
                    Ready to start your cybersecurity journey?
                  </h3>
                  <p className="mt-2 text-sm text-[#F1F1F1]">
                    Join our flagship course and learn OSINT plus web application pentesting with a structured workflow.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to="/courses">
                    <button className="rounded-full border border-white/65 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">
                      Explore
                    </button>
                  </Link>
                  <Link to={featuredLiveCourseLink}>
                    <button className="rounded-full bg-[#F4F4F4] px-4 py-2 text-sm font-semibold text-[#272727] hover:bg-white">
                      Join Now
                    </button>
                  </Link>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      </div>

      <PublicEnrollmentRequestModal
        isOpen={Boolean(landingPublicLeadTarget)}
        onClose={() => setLandingPublicLeadTarget(null)}
        targetType="live_class"
        targetId={landingPublicLeadTarget?.id}
        targetName={landingPublicLeadTarget?.title}
        sourcePath="/"
        loginPath="/login"
      />
    </div>
  );
}




