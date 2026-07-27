import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Button from "../components/Button";
import OsintToolsAccessCard from "../components/OsintToolsAccessCard";
import PageShell from "../components/PageShell";
import { getCourse } from "../api/courses";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { getPurchaseUnavailableMessage, isOsintCourse } from "../utils/courseAccess";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";
import { normalizeTextList } from "../utils/textList";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

function normalizeEnrollmentStatus(value) {
  const raw = String(value || "none").toLowerCase();
  if (raw === "paid" || raw === "approved") return "approved";
  if (raw === "pending") return "pending";
  if (raw === "failed" || raw === "rejected" || raw === "cancelled" || raw === "canceled") return "none";
  return raw || "none";
}

function withNormalizedEnrollment(courseData) {
  if (!courseData) return courseData;
  const enrollmentStatus = normalizeEnrollmentStatus(courseData.enrollment_status);
  const isEnrolled = Boolean(courseData.is_enrolled) || enrollmentStatus === "approved";
  return {
    ...courseData,
    enrollment_status: enrollmentStatus,
    is_enrolled: isEnrolled,
  };
}

function formatCategory(category) {
  if (category === "web_pentesting") return "Web Pentesting";
  if (category === "osint") return "OSINT";
  return "Cybersecurity";
}

function formatLevel(level) {
  if (!level) return "Program";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function deriveOutcomes(course, sections, launchStatus) {
  const configuredOutcomes = normalizeTextList(course?.expected_outcomes).slice(0, 4);
  if (configuredOutcomes.length) return configuredOutcomes;

  const legacyLearningPoints = normalizeTextList(course?.learning_points).slice(0, 4);
  if (legacyLearningPoints.length) return legacyLearningPoints;

  const fromSections = (sections || [])
    .slice(0, 4)
    .map((section) => section?.title)
    .filter(Boolean)
    .map((title) => `Work confidently through ${title.toLowerCase()}.`);

  if (fromSections.length) return fromSections;

  return [
    `Build ${formatCategory(course?.category).toLowerCase()} workflow habits.`,
    `Follow a ${formatLevel(course?.level).toLowerCase()} progression with structured modules.`,
    launchStatus.isComingSoon ? "Prepare for launch updates and curriculum release." : "Start learning immediately after enrollment.",
  ];
}

function toParagraphList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildExtendedCourseDescription(course, sections) {
  const base =
    course?.description ||
    "Structured cybersecurity training with practical modules and guided progression.";

  if (!sections?.length) return [base];

  const moduleNames = sections.map((section) => section?.title).filter(Boolean);
  const describedModules = sections
    .filter((section) => section?.title && section?.description)
    .slice(0, 3);

  const moduleSentence =
    moduleNames.length === 1
      ? `The curriculum is organized into 1 module covering ${moduleNames[0]}.`
      : `The curriculum is organized into ${moduleNames.length} modules, including ${moduleNames
          .slice(0, 4)
          .join(", ")}${moduleNames.length > 4 ? ", and more" : ""}.`;

  const detailSentence = describedModules.length
    ? describedModules
        .map((section) => `${section.title}: ${section.description}`)
        .join(" ")
    : "Each module is designed to move from concepts to practical workflow execution.";

  return [base, moduleSentence, detailSentence];
}

export default function CourseDetailPage() {
  const { id } = useParams();
  const { isAuthenticated } = useAuth();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [previewImageFailed, setPreviewImageFailed] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getCourse(id);
        if (active) setCourse(withNormalizedEnrollment(apiData(response)));
      } catch (err) {
        if (!active) return;
        setCourse(null);
        setError(apiMessage(err, "Failed to load course details."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    setPreviewImageFailed(false);
  }, [id, course?.thumbnail]);

  const normalizedEnrollmentStatus = useMemo(
    () => normalizeEnrollmentStatus(course?.enrollment_status),
    [course?.enrollment_status]
  );
  const hasApprovedEnrollment = Boolean(course?.is_enrolled) || normalizedEnrollmentStatus === "approved";
  const purchaseAvailable = Boolean(course?.purchase_available);

  useEffect(() => {
    if (!isAuthenticated || normalizedEnrollmentStatus !== "pending") return undefined;
    let active = true;

    const refreshEnrollmentStatus = async () => {
      try {
        const response = await getCourse(id);
        if (!active) return;
        const latest = withNormalizedEnrollment(apiData(response));
        setCourse((prev) => (prev ? { ...prev, ...latest } : latest));
      } catch {
        // Silently ignore status refresh failures; main fetch path already handles errors.
      }
    };

    const intervalId = window.setInterval(refreshEnrollmentStatus, 12000);
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        refreshEnrollmentStatus();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [id, isAuthenticated, normalizedEnrollmentStatus]);

  const sections = course?.sections || [];
  const liveClasses = Array.isArray(course?.live_classes) ? course.live_classes : [];
  const lectureCount = useMemo(
    () => sections.reduce((acc, section) => acc + (section.lectures?.length || 0), 0),
    [sections]
  );
  const launchStatus = useMemo(() => getCourseLaunchStatus(course), [course]);
  const highlights = useMemo(() => {
    if (!course) return [];
    const configuredHighlights = normalizeTextList(course.what_you_will_learn).slice(0, 6);
    if (configuredHighlights.length) return configuredHighlights;

    const sectionTitles = sections.map((section) => section.title).slice(0, 4);
    if (sectionTitles.length) return sectionTitles;
    return [
      `${formatCategory(course.category)} track`,
      `${formatLevel(course.level)} level`,
      launchStatus.isComingSoon ? "Launching soon" : "Enrollment open",
    ];
  }, [course, sections, launchStatus.isComingSoon]);

  const outcomes = useMemo(() => deriveOutcomes(course, sections, launchStatus), [course, sections, launchStatus]);
  const extendedCourseDescription = useMemo(
    () => buildExtendedCourseDescription(course, sections),
    [course, sections]
  );
  const aboutCourseParagraphs = useMemo(() => {
    const configured = toParagraphList(course?.about_the_course);
    return configured.length ? configured : extendedCourseDescription;
  }, [course?.about_the_course, extendedCourseDescription]);
  const courseOverviewText = useMemo(
    () =>
      String(course?.course_overview || "").trim() ||
      course?.description ||
      "Structured cybersecurity training with practical modules and guided progression.",
    [course?.course_overview, course?.description]
  );
  const enrollmentInfoText = useMemo(() => {
    const configured = String(course?.enrollment_message || "").trim();
    if (configured) return configured;
    return launchStatus.isComingSoon
      ? "This track is not live yet. We will open enrollment once the curriculum release is ready."
      : purchaseAvailable
        ? "Buy securely for immediate verified access to the course and its linked live classes."
        : getPurchaseUnavailableMessage(course);
  }, [course, course?.enrollment_message, launchStatus.isComingSoon, purchaseAvailable]);
  const snapshotCategoryText = useMemo(
    () => String(course?.snapshot_category || "").trim() || formatCategory(course?.category),
    [course?.snapshot_category, course?.category]
  );
  const snapshotLevelText = useMemo(
    () => String(course?.snapshot_level || "").trim() || formatLevel(course?.level),
    [course?.snapshot_level, course?.level]
  );
  const snapshotInstructorText = useMemo(
    () => String(course?.snapshot_instructor || "").trim() || course?.instructor?.full_name || "Instructor",
    [course?.snapshot_instructor, course?.instructor?.full_name]
  );

  const renderPrimaryEnrollmentAction = ({ className = "w-full" } = {}) => (
    <div className="space-y-2">
      {launchStatus.isComingSoon ? (
        <Button
          className={`border border-[#D1D1D1]/70 bg-[linear-gradient(90deg,#DBDBDB_0%,#C4C4C4_55%,#A1A1A1_100%)] text-[#141414] shadow-[0_8px_18px_rgba(0,0,0,0.18)] hover:bg-[linear-gradient(90deg,#E1E1E1_0%,#CBCBCB_55%,#ABABAB_100%)] ${className}`.trim()}
          disabled
        >
          Coming Soon
        </Button>
      ) : !isAuthenticated ? (
        <Link to="/login" className="block">
          <Button className={className}>Sign In to Continue</Button>
        </Link>
      ) : hasApprovedEnrollment ? (
        <Link to={`/learn/${course.id}`} className="block">
          <Button className={className}>Continue Course</Button>
        </Link>
      ) : purchaseAvailable ? (
        <Link to={`/courses/${course.id}/payment`} className="block">
          <Button className={className}>Buy Course</Button>
        </Link>
      ) : normalizedEnrollmentStatus === "pending" ? (
        <Button className={className} disabled>
          Legacy Access Request Pending
        </Button>
      ) : (
        <Button className={className} disabled>
          Purchase Unavailable
        </Button>
      )}
    </div>
  );

  if (loading) {
    return <PageShell title="Course">Loading...</PageShell>;
  }

  if (!course) {
    return (
      <PageShell title="Course">
        <p className="text-sm text-red-400">{error || "Course not found."}</p>
      </PageShell>
    );
  }

  return (
    <PageShell title={course.title} subtitle={course.description}>
      {error ? (
        <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      ) : null}

      <section className="relative mb-5 min-w-0 overflow-hidden rounded-[18px] border border-black bg-[#080808] shadow-[0_18px_50px_rgba(0,0,0,0.32)] sm:mb-6 sm:rounded-[30px] sm:shadow-[0_26px_70px_rgba(0,0,0,0.36)]">
        <div className="absolute inset-0">
          <img
            src={course.thumbnail || pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.2]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/90 via-black/76 to-[#111111]/95" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(192,192,192,0.12),transparent_40%)]" />
        </div>

        <div className="relative grid min-w-0 gap-4 p-3 sm:gap-5 sm:p-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/70 bg-white/90 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-neutral-900">
                {formatCategory(course.category)}
              </span>
              <span className="rounded-full border border-black bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-[#DBDBDB]">
                {formatLevel(course.level)}
              </span>
              <span
                className={`rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.14em] ${
                  launchStatus.isLive
                    ? "border border-[#E5E5E5]/80 bg-[linear-gradient(135deg,#FEFEFE_0%,#F5F5F5_55%,#D4D4D4_100%)] text-[#242424]"
                    : "border border-[#CCCCCC] bg-[#D9D9D9] text-[#131313]"
                }`}
              >
                {launchStatus.label}
              </span>
            </div>

            <h2 className="mt-4 max-w-3xl break-words font-reference text-[1.65rem] font-semibold leading-[1.08] text-white sm:text-3xl lg:text-[2.35rem]">
              {course.title}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#BBBBBB]">
              {course.description || "Structured cybersecurity training with practical modules and guided progression."}
            </p>

            <div className="mt-4 w-full sm:max-w-sm">
              {renderPrimaryEnrollmentAction()}
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
              <div className="min-w-0 rounded-xl border border-black panel-gradient p-2.5 backdrop-blur-sm sm:rounded-2xl sm:p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Modules</div>
                <div className="mt-1 text-xl font-semibold text-white sm:text-2xl">{sections.length}</div>
                <div className="mt-1 hidden text-xs text-[#BBBBBB] sm:block">Curriculum sections</div>
              </div>
              <div className="min-w-0 rounded-xl border border-black panel-gradient p-2.5 backdrop-blur-sm sm:rounded-2xl sm:p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Lessons</div>
                <div className="mt-1 text-xl font-semibold text-white sm:text-2xl">{lectureCount}</div>
                <div className="mt-1 hidden text-xs text-[#BBBBBB] sm:block">Lecture entries</div>
              </div>
              <div className="min-w-0 rounded-xl border border-black panel-gradient p-2.5 backdrop-blur-sm sm:rounded-2xl sm:p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#949494]">Access</div>
                <div className="mt-1 break-words text-sm font-semibold leading-tight text-white sm:text-lg">
                  {launchStatus.isComingSoon ? "Coming Soon" : formatINR(course.price)}
                </div>
                <div className="mt-1 hidden text-xs text-[#BBBBBB] sm:block">
                  {launchStatus.isComingSoon ? "Waitlist release" : "Admin-approved access"}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-black panel-gradient p-3.5 backdrop-blur-sm sm:rounded-2xl sm:p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                About This Course
              </div>
              <div className="mt-3 space-y-2">
                {aboutCourseParagraphs.map((paragraph, index) => (
                  <p key={`${index}-${paragraph.slice(0, 24)}`} className="text-sm leading-7 text-[#CACACA]">
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          </div>

          <div className="min-w-0 space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-black panel-gradient p-3 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-sm">
              <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-black panel-gradient">
                {course.thumbnail && !previewImageFailed ? (
                  <img
                    src={course.thumbnail}
                    alt={course.title}
                    className="h-full w-full object-cover opacity-[0.82]"
                    onError={() => setPreviewImageFailed(true)}
                  />
                ) : (
                  <div className="absolute inset-0">
                    <img
                      src={pageBackgroundImage}
                      alt=""
                      aria-hidden="true"
                      className="h-full w-full object-cover opacity-[0.22]"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,rgba(192,192,192,0.12),transparent_42%)]" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/35 to-black/10" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  <div className="rounded-xl border border-[#DADADA]/10 bg-[#121212]/88 p-3 backdrop-blur-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                      Course Overview
                    </div>
                    <p className="mt-2 line-clamp-4 text-sm leading-6 text-[#D8D8D8]">
                      {courseOverviewText}
                    </p>
                  </div>
                </div>
              </div>
              <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_100%_0%,rgba(192,192,192,0.08),transparent_40%)]" />
            </div>

            <div className="rounded-2xl border border-black panel-gradient p-4 backdrop-blur-sm">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                What You Will Cover
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {highlights.map((item, index) => (
                  <span
                    key={`${item}-${index}`}
                    className="rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-medium text-[#CFCFCF]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid min-w-0 gap-4 sm:gap-6 lg:grid-cols-[1.55fr_1fr]">
        <div className="min-w-0 space-y-4 sm:space-y-6">
          {hasApprovedEnrollment && isOsintCourse(course) ? <OsintToolsAccessCard /> : null}

          {hasApprovedEnrollment && liveClasses.length ? (
            <section className="rounded-[18px] border border-white/15 bg-[#101010] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.25)] sm:rounded-[24px] sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#A0A0A0]">
                    Included With This Course
                  </div>
                  <h2 className="mt-2 font-reference text-xl font-semibold text-white">
                    Live classroom
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-[#AFAFAF]">
                    Your approved course access includes these linked live classes. No separate
                    live-class request is required.
                  </p>
                </div>
                <Link
                  to={`/courses/${course.id}/live`}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E6E6E6]"
                >
                  Open Live Classroom
                </Link>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {liveClasses.map((liveClass) => (
                  <Link
                    key={liveClass.id}
                    to={`/courses/${course.id}/live`}
                    className="group rounded-2xl border border-white/10 bg-black/35 p-4 transition hover:border-white/30 hover:bg-black/55"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-reference text-base font-semibold text-white">
                          {liveClass.title}
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[#999999]">
                          {liveClass.schedule_days || "Friday, Saturday and Sunday"} /{" "}
                          {liveClass.class_duration_minutes || 60} minutes
                        </p>
                      </div>
                      <span className="text-lg text-[#BDBDBD] transition group-hover:translate-x-1">
                        -&gt;
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          <section className="min-w-0 rounded-[18px] border border-black panel-gradient p-4 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:rounded-[24px] sm:p-5">
            <div className="mb-4 flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="font-reference text-lg font-semibold text-white">Course Roadmap</h2>
                <p className="mt-1 text-xs leading-5 text-[#949494]">
                  Module-by-module breakdown with lecture previews and section descriptions.
                </p>
              </div>
              <span className="max-w-full rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-semibold text-[#CACACA]">
                {sections.length} modules / {lectureCount} lessons
              </span>
            </div>

            {sections.length ? (
              <div className="space-y-4">
                {sections.map((section, sectionIndex) => (
                  <div
                    key={section.id}
                    className="relative min-w-0 overflow-hidden rounded-xl border border-black panel-gradient p-3.5 sm:rounded-2xl sm:p-4"
                  >
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_100%_0%,rgba(192,192,192,0.05),transparent_45%)]" />
                    <div className="relative">
                      <div className="mb-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                        <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row">
                          <span className="shrink-0 whitespace-nowrap rounded-full border border-[#DADADA]/20 bg-[#1A1A1A] px-3 py-1 text-[11px] font-semibold tracking-wide text-[#D7D7D7]">
                            Module {sectionIndex + 1}
                          </span>
                          <h3 className="w-full min-w-0 break-words font-reference text-base font-semibold leading-snug text-white sm:text-lg">
                            {section.title}
                          </h3>
                        </div>
                        <span className="shrink-0 whitespace-nowrap rounded-full border border-black bg-[#121212] px-2.5 py-1 text-[11px] font-semibold text-[#BBBBBB]">
                          {(section.lectures || []).length} lesson{(section.lectures || []).length === 1 ? "" : "s"}
                        </span>
                      </div>

                      {section.description ? (
                        <p className="text-sm leading-6 text-[#B2B2B2]">{section.description}</p>
                      ) : null}

                      <ul className="mt-4 space-y-2">
                        {(section.lectures || []).map((lecture, lectureIndex) => (
                          <li
                            key={lecture.id}
                            className="rounded-xl border border-black panel-gradient px-3 py-3"
                          >
                            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-black bg-[#171717] px-1 text-[10px] font-semibold text-[#D3D3D3]">
                                  {lectureIndex + 1}
                                </span>
                                <div className="min-w-0">
                                  <div className="break-words text-sm font-medium leading-5 text-[#E2E2E2]">
                                    {lecture.title}
                                  </div>
                                  {lecture.description ? (
                                    <p className="mt-1 text-xs leading-5 text-[#949494]">
                                      {lecture.description}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              {lecture.is_preview ? (
                                <span className="shrink-0 rounded-full border border-black bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#DBDBDB]">
                                  Preview
                                </span>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-black panel-gradient p-4 text-sm text-[#BBBBBB]">
                Curriculum modules will appear here once sections are added in the backend.
              </div>
            )}
          </section>

          <section className="rounded-[18px] border border-black panel-gradient p-4 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:rounded-[24px] sm:p-5">
            <div className="mb-4">
              <h2 className="font-reference text-lg font-semibold text-white">Expected Outcomes</h2>
              <p className="mt-1 text-xs leading-5 text-[#949494]">
                Practical goals learners should be able to achieve after completing this track.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {outcomes.map((item, index) => (
                <div
                  key={`${item}-${index}`}
                  className="flex items-start gap-3 rounded-xl border border-black panel-gradient px-3 py-3 text-sm text-[#C8C8C8]"
                >
                  <span className="mt-1 inline-flex h-2.5 w-2.5 rounded-full bg-[#C0C0C0]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0 space-y-4 sm:space-y-5 lg:sticky lg:top-24 lg:h-fit">
          <div className="rounded-[18px] border border-black panel-gradient p-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:rounded-[24px] sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
                Enrollment
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] ${
                  launchStatus.isLive
                    ? "border border-[#E5E5E5]/80 bg-[linear-gradient(135deg,#FEFEFE_0%,#F5F5F5_55%,#D4D4D4_100%)] text-[#242424]"
                    : "border border-[#CCCCCC] bg-[#D9D9D9] text-[#131313]"
                }`}
              >
                {launchStatus.label}
              </span>
            </div>

            <div className="mt-4">
              {renderPrimaryEnrollmentAction()}
            </div>

            <div className="mt-4 font-reference text-3xl font-semibold tracking-tight text-white">
              {launchStatus.isComingSoon ? "Coming Soon" : formatINR(course.price)}
            </div>
            <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
              {sections.length} modules / {lectureCount} lessons / {formatLevel(course.level)} level
            </p>

            <div className="mt-4 grid gap-2">
              {highlights.slice(0, 4).map((point, index) => (
                <div
                  key={`${point}-${index}`}
                  className="rounded-lg border border-black panel-gradient px-3 py-2 text-sm text-[#C8C8C8]"
                >
                  {point}
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-2">
              <Link to="/courses" className="block">
                <Button variant="secondary" className="w-full">
                  Back to Catalog
                </Button>
              </Link>
            </div>

            <p className="mt-3 text-xs leading-5 text-[#949494]">
              {enrollmentInfoText}
            </p>
          </div>

          <div className="rounded-[18px] border border-black panel-gradient p-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:rounded-[24px] sm:p-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Course Snapshot
            </div>
            <div className="mt-3 grid gap-2">
              <div className="rounded-xl border border-black panel-gradient px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Category</div>
                <div className="mt-1 text-sm font-semibold text-[#E3E3E3]">
                  {snapshotCategoryText}
                </div>
              </div>
              <div className="rounded-xl border border-black panel-gradient px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Level</div>
                <div className="mt-1 text-sm font-semibold text-[#E3E3E3]">{snapshotLevelText}</div>
              </div>
              <div className="rounded-xl border border-black panel-gradient px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Instructor</div>
                <div className="mt-1 text-sm font-semibold text-[#E3E3E3]">
                  {snapshotInstructorText}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
