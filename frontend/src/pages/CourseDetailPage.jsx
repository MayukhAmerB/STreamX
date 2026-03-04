import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { getCourse } from "../api/courses";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";
import { featuredCourse } from "../utils/featuredCourse";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

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
  if (Array.isArray(course?.learning_points) && course.learning_points.length) {
    return course.learning_points.filter(Boolean).slice(0, 4);
  }

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
  const navigate = useNavigate();
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
        if (active) setCourse(apiData(response));
      } catch (err) {
        if (!active) return;
        const fallbackAllowed = String(id) === String(featuredCourse.id);
        setCourse(fallbackAllowed ? featuredCourse : null);
        setError(
          fallbackAllowed
            ? "Showing local course preview. Backend is unavailable."
            : apiMessage(err, "Failed to load course details.")
        );
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

  const sections = course?.sections || [];
  const lectureCount = useMemo(
    () => sections.reduce((acc, section) => acc + (section.lectures?.length || 0), 0),
    [sections]
  );
  const launchStatus = useMemo(() => getCourseLaunchStatus(course), [course]);
  const highlights = useMemo(() => {
    if (!course) return [];
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

  const handleBuy = () => {
    if (launchStatus.isComingSoon) return;
    if (!isAuthenticated) {
      navigate("/login", { state: { from: `/courses/${id}/payment` } });
      return;
    }
    navigate(`/courses/${id}/payment`);
  };

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

      <section className="relative mb-6 overflow-hidden rounded-[30px] border border-[#cfd8c5]/10 bg-[#070907] shadow-[0_26px_70px_rgba(0,0,0,0.36)]">
        <div className="absolute inset-0">
          <img
            src={course.thumbnail || pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.2]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/90 via-black/76 to-[#0d130f]/95" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(185,199,171,0.12),transparent_40%)]" />
          <div className="absolute inset-0 opacity-15 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:26px_26px]" />
        </div>

        <div className="relative grid gap-5 p-5 sm:p-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/70 bg-white/90 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-neutral-900">
                {formatCategory(course.category)}
              </span>
              <span className="rounded-full border border-[#cfd8c5]/20 bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-[#d7e0cc]">
                {formatLevel(course.level)}
              </span>
              <span
                className={`rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.14em] ${
                  launchStatus.isLive
                    ? "border border-[#d7e4ce] bg-[#eef3e8] text-[#1f2d21]"
                    : "border border-amber-200/90 bg-amber-50 text-amber-900"
                }`}
              >
                {launchStatus.label}
              </span>
            </div>

            <h2 className="mt-4 max-w-3xl font-reference text-2xl font-semibold leading-tight text-white sm:text-3xl lg:text-[2.35rem]">
              {course.title}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-[#b7c0b0]">
              {course.description || "Structured cybersecurity training with practical modules and guided progression."}
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Modules</div>
                <div className="mt-1 text-2xl font-semibold text-white">{sections.length}</div>
                <div className="mt-1 text-xs text-[#b7c0b0]">Curriculum sections</div>
              </div>
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Lessons</div>
                <div className="mt-1 text-2xl font-semibold text-white">{lectureCount}</div>
                <div className="mt-1 text-xs text-[#b7c0b0]">Lecture entries</div>
              </div>
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Access</div>
                <div className="mt-1 text-lg font-semibold text-white">
                  {launchStatus.isComingSoon ? "Coming Soon" : formatINR(course.price)}
                </div>
                <div className="mt-1 text-xs text-[#b7c0b0]">
                  {launchStatus.isComingSoon ? "Waitlist release" : "One-time enrollment"}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-[#243025] bg-[#0d120f]/88 p-4 backdrop-blur-sm">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
                About This Course
              </div>
              <div className="mt-3 space-y-2">
                {extendedCourseDescription.map((paragraph, index) => (
                  <p key={`${index}-${paragraph.slice(0, 24)}`} className="text-sm leading-7 text-[#c6cfbd]">
                    {paragraph}
                  </p>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="relative overflow-hidden rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.25)] backdrop-blur-sm">
              <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-[#1f2820] bg-[#090c09]">
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
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,rgba(185,199,171,0.12),transparent_42%)]" />
                    <div className="absolute inset-0 opacity-15 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:22px_22px]" />
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/35 to-black/10" />
                <div className="absolute inset-x-0 bottom-0 p-4">
                  <div className="rounded-xl border border-[#d6decc]/10 bg-[#0f1410]/88 p-3 backdrop-blur-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8f9989]">
                      Course Overview
                    </div>
                    <p className="mt-2 line-clamp-4 text-sm leading-6 text-[#d4ddca]">
                      {course.description ||
                        "Structured cybersecurity training with practical modules and guided progression."}
                    </p>
                  </div>
                </div>
              </div>
              <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_100%_0%,rgba(185,199,171,0.08),transparent_40%)]" />
            </div>

            <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-4 backdrop-blur-sm">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
                What You Will Cover
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {highlights.map((item, index) => (
                  <span
                    key={`${item}-${index}`}
                    className="rounded-full border border-[#2d382d] bg-[#111612] px-3 py-1 text-xs font-medium text-[#cbd4c1]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.55fr_1fr]">
        <div className="space-y-6">
          <section className="rounded-[24px] border border-[#243025] bg-[#0d120f] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-reference text-lg font-semibold text-white">Course Roadmap</h2>
                <p className="mt-1 text-xs leading-5 text-[#8f9989]">
                  Module-by-module breakdown with lecture previews and section descriptions.
                </p>
              </div>
              <span className="rounded-full border border-[#2f3a30] bg-[#111612] px-3 py-1 text-xs font-semibold text-[#c6cfbd]">
                {sections.length} modules / {lectureCount} lessons
              </span>
            </div>

            {sections.length ? (
              <div className="space-y-4">
                {sections.map((section, sectionIndex) => (
                  <div
                    key={section.id}
                    className="relative overflow-hidden rounded-2xl border border-[#202a21] bg-[#101610] p-4"
                  >
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_100%_0%,rgba(185,199,171,0.05),transparent_45%)]" />
                    <div className="relative">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full border border-[#d6decc]/20 bg-[#161d16] px-3 py-1 text-[11px] font-semibold tracking-wide text-[#d3dcc9]">
                            Module {sectionIndex + 1}
                          </span>
                          <h3 className="font-reference text-base font-semibold text-white sm:text-lg">
                            {section.title}
                          </h3>
                        </div>
                        <span className="rounded-full border border-[#2b372b] bg-[#0f1410] px-2.5 py-1 text-[11px] font-semibold text-[#b7c0b0]">
                          {(section.lectures || []).length} lesson{(section.lectures || []).length === 1 ? "" : "s"}
                        </span>
                      </div>

                      {section.description ? (
                        <p className="text-sm leading-6 text-[#adb6a7]">{section.description}</p>
                      ) : null}

                      <ul className="mt-4 space-y-2">
                        {(section.lectures || []).map((lecture, lectureIndex) => (
                          <li
                            key={lecture.id}
                            className="rounded-xl border border-[#1c241d] bg-[#0c110d] px-3 py-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex min-w-0 items-start gap-3">
                                <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-[#2c372d] bg-[#131913] px-1 text-[10px] font-semibold text-[#cfd8c5]">
                                  {lectureIndex + 1}
                                </span>
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium text-[#dfe6d6]">
                                    {lecture.title}
                                  </div>
                                  {lecture.description ? (
                                    <p className="mt-1 text-xs leading-5 text-[#8f9989]">
                                      {lecture.description}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                              {lecture.is_preview ? (
                                <span className="shrink-0 rounded-full border border-[#cfd8c5]/20 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#d7e0cc]">
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
              <div className="rounded-2xl border border-[#202a21] bg-[#101610] p-4 text-sm text-[#b7c0b0]">
                Curriculum modules will appear here once sections are added in the backend.
              </div>
            )}
          </section>

          <section className="rounded-[24px] border border-[#243025] bg-[#0d120f] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="mb-4">
              <h2 className="font-reference text-lg font-semibold text-white">Expected Outcomes</h2>
              <p className="mt-1 text-xs leading-5 text-[#8f9989]">
                Practical goals learners should be able to achieve after completing this track.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {outcomes.map((item, index) => (
                <div
                  key={`${item}-${index}`}
                  className="flex items-start gap-3 rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-3 text-sm text-[#c4cdba]"
                >
                  <span className="mt-1 inline-flex h-2.5 w-2.5 rounded-full bg-[#b9c7ab]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-24 lg:h-fit">
          <div className="rounded-[24px] border border-[#243025] bg-[#0d120f] p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
                Enrollment
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] ${
                  launchStatus.isLive
                    ? "border border-[#d7e4ce] bg-[#eef3e8] text-[#1f2d21]"
                    : "border border-amber-200/90 bg-amber-50 text-amber-900"
                }`}
              >
                {launchStatus.label}
              </span>
            </div>

            <div className="mt-2 font-reference text-3xl font-semibold tracking-tight text-white">
              {launchStatus.isComingSoon ? "Coming Soon" : formatINR(course.price)}
            </div>
            <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">
              {sections.length} modules / {lectureCount} lessons / {formatLevel(course.level)} level
            </p>

            <div className="mt-4 grid gap-2">
              {highlights.slice(0, 4).map((point, index) => (
                <div
                  key={`${point}-${index}`}
                  className="rounded-lg border border-[#1f2820] bg-[#101610] px-3 py-2 text-sm text-[#c4cdba]"
                >
                  {point}
                </div>
              ))}
            </div>

            <div className="mt-4 space-y-2">
              {launchStatus.isComingSoon ? (
                <Button
                  className="w-full border border-amber-300/20 bg-amber-100/5 text-amber-200 hover:bg-amber-100/5"
                  disabled
                >
                  Coming Soon
                </Button>
              ) : course.is_enrolled ? (
                <Link to={`/learn/${course.id}`} className="block">
                  <Button className="w-full">Go to Course</Button>
                </Link>
              ) : (
                <Button className="w-full" onClick={handleBuy}>
                  {isAuthenticated ? "Buy" : "Login to Buy"}
                </Button>
              )}

              <Link to="/courses" className="block">
                <Button variant="secondary" className="w-full">
                  Back to Catalog
                </Button>
              </Link>
            </div>

            <p className="mt-3 text-xs leading-5 text-[#8f9989]">
              {launchStatus.isComingSoon
                ? "This track is not live yet. We will open enrollment once the curriculum release is ready."
                : "Payment (Card/UPI) works after backend and Razorpay credentials are configured."}
            </p>
          </div>

          <div className="rounded-[24px] border border-[#243025] bg-[#0d120f] p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
              Course Snapshot
            </div>
            <div className="mt-3 grid gap-2">
              <div className="rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Category</div>
                <div className="mt-1 text-sm font-semibold text-[#e0e6d8]">
                  {formatCategory(course.category)}
                </div>
              </div>
              <div className="rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Level</div>
                <div className="mt-1 text-sm font-semibold text-[#e0e6d8]">{formatLevel(course.level)}</div>
              </div>
              <div className="rounded-xl border border-[#1f2820] bg-[#101610] px-3 py-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Instructor</div>
                <div className="mt-1 text-sm font-semibold text-[#e0e6d8]">
                  {course.instructor?.full_name || "Instructor"}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
