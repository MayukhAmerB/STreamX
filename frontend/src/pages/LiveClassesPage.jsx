import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PageShell from "../components/PageShell";
import Button from "../components/Button";
import PublicEnrollmentRequestModal from "../components/PublicEnrollmentRequestModal";
import { enrollInLiveClass, listLiveClasses } from "../api/courses";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { formatINR } from "../utils/currency";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const classSchedule = {
  days: ["Friday", "Saturday", "Sunday"],
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

export default function LiveClassesPage() {
  const { isAuthenticated } = useAuth();
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionState, setActionState] = useState({});
  const [publicLeadTarget, setPublicLeadTarget] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listLiveClasses();
        if (!active) return;
        const liveClasses = apiData(response, []);
        setTracks(liveClasses.length ? liveClasses : fallbackLiveClasses);
        setError("");
      } catch {
        if (!active) return;
        setTracks(fallbackLiveClasses);
        setError("Showing local OSINT live classes preview. Backend is unavailable.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const orderedTracks = useMemo(() => {
    return [...tracks].sort((a, b) => {
      const aLevel = levelOrder[String(a?.level || "").toLowerCase()] || a?.month_number || 99;
      const bLevel = levelOrder[String(b?.level || "").toLowerCase()] || b?.month_number || 99;
      if (aLevel !== bLevel) return aLevel - bLevel;
      return String(a?.title || "").localeCompare(String(b?.title || ""));
    });
  }, [tracks]);

  const handleEnroll = async (liveClassId) => {
    const targetId = toValidLiveClassId(liveClassId);
    if (!targetId) {
      setActionState((prev) => ({
        ...prev,
        [liveClassId]: {
          loading: false,
          error: "Enrollment is unavailable in preview mode.",
          success: "",
        },
      }));
      return;
    }
    setActionState((prev) => ({
      ...prev,
      [liveClassId]: { loading: true, error: "", success: "" },
    }));
    try {
      const response = await enrollInLiveClass({ live_class_id: targetId });
      const data = apiData(response, {});
      const enrollmentStatus = String(data?.enrollment_status || (data?.enrolled ? "approved" : "pending")).toLowerCase();
      setTracks((prev) =>
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
      setActionState((prev) => ({
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
      setActionState((prev) => ({
        ...prev,
        [liveClassId]: { loading: false, error: apiMessage(err, "Unable to enroll."), success: "" },
      }));
    }
  };

  return (
    <PageShell
      title="Live Classes"
      subtitle="Weekend live OSINT classes with a structured month-by-month progression."
    >
      <section className="relative mb-6 overflow-hidden rounded-[30px] border border-[#cfd8c5]/10 bg-[#070907] shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.16]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-black/78 to-[#0d130f]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(185,199,171,0.12),transparent_36%)]" />
          <div className="absolute inset-0 opacity-15 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:26px_26px]" />
        </div>

        <div className="relative grid gap-5 p-5 sm:p-6 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <div className="inline-flex items-center rounded-full border border-[#334033] bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#d7e0cc]">
              WEEKEND LIVE CLASSES
            </div>
            <h2 className="mt-4 max-w-3xl font-reference text-2xl font-semibold leading-tight text-white sm:text-3xl lg:text-[2.2rem]">
              OSINT Live Program (Month 1 to Month 3)
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#b7c0b0]">
              These are live classes, not self-paced course sessions. The OSINT track is delivered
              as a progressive 3-month path: Beginner, Intermediate, and Advanced.
            </p>

            <div className="mt-5 grid gap-3 sm:auto-rows-fr sm:grid-cols-3">
              <div className="h-full rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Class Days</div>
                <div className="mt-1 text-sm font-semibold text-white">{classSchedule.days.join(", ")}</div>
              </div>
              <div className="h-full rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Duration</div>
                <div className="mt-1 text-sm font-semibold text-white">{classSchedule.duration}</div>
              </div>
              <div className="h-full rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Track Length</div>
                <div className="mt-1 text-sm font-semibold text-white">3 Months (OSINT)</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-5 backdrop-blur-sm">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
              Live Class Format
            </div>
            <div className="mt-3 space-y-2">
              {[
                "Friday, Saturday, and Sunday schedule",
                "1 hour per live class session",
                "Month 1 = OSINT Beginner (Foundation)",
                "Month 2 = OSINT Intermediate (Practical Skills)",
                "Month 3 = OSINT Advanced (Investigation & Intelligence)",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-3 text-sm text-[#c4cdba]"
                >
                  <span className="mt-1 inline-flex h-2.5 w-2.5 rounded-full bg-[#b9c7ab]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      ) : null}

      <section className="rounded-[26px] border border-[#202920] bg-[#090d09]/70 p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-lg font-semibold text-white">OSINT Month-Wise Live Classes</h3>
            <p className="mt-1 text-xs text-[#8f9989]">
              Month 1 (Beginner), Month 2 (Intermediate), Month 3 (Advanced)
            </p>
          </div>
          <span className="text-xs text-[#8f9989]">
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
            return (
              <article
                key={course.id}
                className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-[#243025] bg-[#0d120f] p-4 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(185,199,171,0.07),transparent_40%)]" />
                <div className="relative flex h-full flex-1 flex-col">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-[#d6decc]/20 bg-[#161d16] px-3 py-1 text-[11px] font-semibold tracking-wide text-[#d3dcc9]">
                      {monthMeta.label}
                    </span>
                    <span className="rounded-full border border-[#d7e4ce] bg-[#eef3e8] px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-[#1f2d21]">
                      Live
                    </span>
                  </div>

                  <div className="mb-2 min-h-[1rem] text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8f9989]">
                    {monthMeta.subtitle}
                  </div>
                  <h4 className="font-reference text-xl font-semibold leading-tight text-white lg:min-h-[5rem]">
                    {course.title}
                  </h4>
                  <p className="mt-3 text-sm leading-6 text-[#b7c0b0] lg:min-h-[6rem]">
                    {course.description || "OSINT live class track with guided progression."}
                  </p>

                  <div className="mt-4 grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-3">
                    <div className="h-full rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Schedule</div>
                      <div className="mt-1 text-xs font-semibold text-[#dce4d2]">Fri / Sat / Sun</div>
                    </div>
                    <div className="h-full rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Duration</div>
                      <div className="mt-1 text-xs font-semibold text-[#dce4d2]">
                        {course.class_duration_minutes ? `${course.class_duration_minutes} min` : "1 hour"}
                      </div>
                    </div>
                    <div className="h-full rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-2">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Price</div>
                      <div className="mt-1 text-xs font-semibold text-[#dce4d2]">
                        {formatLiveClassPrice(course.price)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                    <span className="rounded-full border border-[#2f3a30] bg-[#111612] px-3 py-1 text-xs font-semibold text-[#c6cfbd]">
                      {(course.enrollment_count ?? 0)} enrolled
                    </span>
                    {course.linked_course_id ? (
                      <Link
                        to={`/courses/${course.linked_course_id}`}
                        className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#c9d5bd] to-[#8fa184] px-4 py-2 text-sm font-semibold text-[#101410] transition hover:from-[#d7e0cc] hover:to-[#9daf93]"
                      >
                        View Course
                      </Link>
                    ) : (
                      <span className="inline-flex items-center justify-center rounded-full border border-[#2f3a30] bg-[#111612] px-4 py-2 text-sm font-semibold text-[#d7e0cc]">
                        Preview
                      </span>
                    )}
                  </div>

                  <div className="mt-auto pt-4">
                    {course.is_enrolled || String(course.enrollment_status || "").toLowerCase() === "approved" ? (
                      <Button className="w-full" disabled>
                        Enrolled
                      </Button>
                    ) : String(course.enrollment_status || "").toLowerCase() === "pending" ? (
                      <Button className="w-full" disabled>
                        Pending Approval
                      </Button>
                    ) : isAuthenticated ? (
                      <Button
                        className="w-full"
                        onClick={() => handleEnroll(course.id)}
                        loading={Boolean(actionState[course.id]?.loading)}
                      >
                        Enroll
                      </Button>
                    ) : (
                      <Button
                        className="w-full"
                        onClick={() => {
                          const targetId = toValidLiveClassId(course.id);
                          if (!targetId) {
                            setActionState((prev) => ({
                              ...prev,
                              [course.id]: {
                                loading: false,
                                error: "Enrollment is unavailable in preview mode.",
                                success: "",
                              },
                            }));
                            return;
                          }
                          setPublicLeadTarget({
                            id: targetId,
                            title: course.title,
                          });
                        }}
                      >
                        Enroll
                      </Button>
                    )}
                    {actionState[course.id]?.error ? (
                      <p className="mt-2 text-xs text-red-300">{actionState[course.id].error}</p>
                    ) : null}
                    {actionState[course.id]?.success ? (
                      <p className="mt-2 text-xs text-green-300">{actionState[course.id].success}</p>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <PublicEnrollmentRequestModal
        isOpen={Boolean(publicLeadTarget)}
        onClose={() => setPublicLeadTarget(null)}
        targetType="live_class"
        targetId={publicLeadTarget?.id}
        targetName={publicLeadTarget?.title}
        sourcePath="/live-classes"
        loginPath="/login"
      />
    </PageShell>
  );
}
