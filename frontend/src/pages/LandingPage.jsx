import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listCourses } from "../api/courses";
import Button from "../components/Button";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { apiData } from "../utils/api";
import { featuredCourse } from "../utils/featuredCourse";

const brandBackgroundImage =
  "https://i.pinimg.com/736x/e7/18/de/e718de74d25e0e9a2cf62cd126b3abb5.jpg";
const heroCardImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

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

const popularPrograms = [
  {
    id: "osint-beginner",
    title: "OSINT Beginner",
    lessons: 2,
    bullets: ["Search operator fundamentals", "Evidence capture and source validation"],
  },
  {
    id: "osint-intermediate",
    title: "OSINT Intermediate",
    lessons: 2,
    bullets: ["Target profiling workflow", "Correlation and investigation notes"],
  },
  {
    id: "osint-advanced",
    title: "OSINT Advanced",
    lessons: 2,
    bullets: ["Advanced collection planning", "Validation and reporting workflow"],
  },
  {
    id: "web-pentest-beginner",
    title: "Web Application Pentesting Beginner",
    lessons: 0,
    bullets: ["Fundamentals and testing setup", "Beginner methodology track (coming soon)"],
  },
  {
    id: "web-pentest-intermediate",
    title: "Web Application Pentesting Intermediate",
    lessons: 0,
    bullets: ["Recon and auth testing flow", "Intermediate workflow track (coming soon)"],
  },
  {
    id: "web-pentest-advanced",
    title: "Web Application Pentesting Advanced",
    lessons: 0,
    bullets: ["Advanced testing scenarios", "Reporting and validation track (coming soon)"],
  },
];

const levelOrder = { beginner: 1, intermediate: 2, advanced: 3 };
const categoryOrder = { osint: 1, web_pentesting: 2 };

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
      className={`mx-auto max-w-6xl rounded-[24px] border border-[#b9c7ab]/16 bg-gradient-to-br from-[#0c100d] via-[#121813] to-[#090b09] p-4 shadow-[0_12px_30px_rgba(0,0,0,0.22)] sm:p-6 ${className}`}
    >
      {children}
    </section>
  );
}

function SectionTitle({ title, subtitle }) {
  return (
    <div className="text-center">
      <h2 className="font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        {title}
      </h2>
      {subtitle ? (
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[#cfd7c9] sm:text-base">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

export default function LandingPage() {
  const [catalogCourses, setCatalogCourses] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listCourses();
        if (!active) return;
        setCatalogCourses(sortCatalogCourses(apiData(response, [])));
      } catch {
        if (!active) return;
        setCatalogCourses([]);
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

  const landingPrograms = useMemo(() => {
    if (catalogCourses.length) return catalogCourses;
    return popularPrograms.map((program, index) => ({
      id: program.id,
      title: program.title,
      description: "Structured lessons focused on practical workflow and real application in security assessments.",
      section_count: program.lessons,
      launch_status: getCourseLaunchStatus(program).key === "coming_soon" ? "coming_soon" : "live",
      _fallbackLink: "/courses",
      _bullets: program.bullets,
      _index: index,
    }));
  }, [catalogCourses]);

  return (
    <div className="bg-transparent text-[#f5f7f1]">
      <section className="relative overflow-hidden px-4 pb-8 pt-6 sm:pt-10">
        <div className="absolute inset-0">
          <img
            src={brandBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.14] blur-[2px] grayscale"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/72 via-black/82 to-black/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_14%,rgba(185,199,171,0.16),transparent_34%)]" />
          <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(207,216,197,0.32)_1px,transparent_1px),linear-gradient(90deg,rgba(207,216,197,0.28)_1px,transparent_1px)] [background-size:32px_32px]" />
        </div>
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[30px] border border-[#d5deca]/10 bg-[linear-gradient(135deg,rgba(6,9,7,0.98),rgba(11,15,11,0.96),rgba(5,6,5,0.99))] shadow-[0_28px_80px_rgba(0,0,0,0.42)]">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#dbe4d0]/40 to-transparent" />
          <div className="grid items-center gap-8 p-5 sm:p-7 lg:grid-cols-[1.03fr_0.97fr]">
            <div className="reveal-up">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#99aa8e]/30 bg-white/5 px-3 py-1 text-xs font-semibold tracking-wide text-[#d7e0cc]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#b9c7ab]" />
                Al syed Initiative Cybersecurity Platform
              </div>

              <h1 className="mt-5 max-w-xl font-reference text-4xl font-semibold leading-[1.02] tracking-tight text-white sm:text-5xl lg:text-6xl">
                Learn Cyber Security with Expert-Led Practical Training
              </h1>

              <p className="mt-5 max-w-xl text-sm leading-7 text-[#b7c0b0] sm:text-base">
                We teach cybersecurity through structured OSINT, reconnaissance, and web application
                penetration testing workflows. Trusted by over 1000 students building practical skills.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link to={`/courses/${featuredLiveCourse.id}`}>
                  <Button className="rounded-full bg-gradient-to-r from-[#c9d5bd] to-[#8fa184] px-5 text-[#101410] hover:from-[#d7e0cc] hover:to-[#9daf93]">
                    View Flagship Course
                  </Button>
                </Link>
                <Link to="/courses">
                  <Button
                    variant="indigoSoft"
                    className="glossy rounded-full !border-[#fff4d4] !bg-[linear-gradient(135deg,#fffef9_0%,#fff7e5_52%,#f3e2b6_100%)] px-5 !text-[#101410] shadow-[0_14px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.95)] hover:!bg-[linear-gradient(135deg,#ffffff_0%,#fff9eb_52%,#f5e6c0_100%)]"
                  >
                    Explore Programs
                  </Button>
                </Link>
              </div>

              <div className="mt-5 rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-4 shadow-[0_18px_40px_rgba(0,0,0,0.22)]">
                <div className="grid gap-2 text-sm text-[#b7c0b0] sm:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d7e0cc]" />
                    OSINT and attack surface mapping
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d7e0cc]" />
                    Web application pentesting workflow
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d7e0cc]" />
                    Practical lessons and structured modules
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d7e0cc]" />
                    Ethical and professional methodology
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["OSINT", "Web App Pentesting", "Recon Workflow"].map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-[#2d382e] bg-[#111612] px-3 py-1 text-xs font-semibold text-[#d7e0cc]"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="reveal-up reveal-delay-1 relative">
              <div className="rounded-[28px] border border-[#273127] bg-[#0c110d] p-3 shadow-[0_24px_60px_rgba(0,0,0,0.36)]">
                <div className="relative h-[360px] overflow-hidden rounded-[24px] border border-[#1e261f] bg-black sm:h-[420px]">
                  <img
                    src={heroCardImage}
                    alt="Cybersecurity training visual"
                    className="h-full w-full object-cover opacity-[0.9]"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/78 via-black/30 to-black/12" />
                  <div className="absolute inset-0 opacity-[0.14] [background-image:linear-gradient(rgba(207,216,197,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(207,216,197,0.12)_1px,transparent_1px)] [background-size:24px_24px]" />
                  <div className="absolute left-4 top-4 rounded-2xl border border-[#dbe4d0]/12 bg-[#0d120f]/86 px-4 py-3 backdrop-blur-sm">
                    <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#8f9989]">
                      LIVE TRAINING
                    </div>
                    <div className="mt-2 text-lg font-semibold text-white">Structured cybersecurity learning</div>
                    <div className="mt-1 max-w-[220px] text-xs leading-5 text-[#b7c0b0]">
                      Guided modules, professional instruction, and practical workflow-based training.
                    </div>
                  </div>

                  <div className="absolute inset-x-4 bottom-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[#dbe4d0]/12 bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#8f9989]">1000+ Students</div>
                      <div className="mt-2 text-sm font-semibold text-[#e2e9d8]">Active cybersecurity learners</div>
                    </div>
                    <div className="rounded-2xl border border-[#dbe4d0]/12 bg-[#0d120f]/88 p-3 backdrop-blur-sm">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-[#8f9989]">Top-Rated Training</div>
                      <div className="mt-2 text-sm font-semibold text-[#e2e9d8]">Workflow-first progression</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="px-4 pb-16">
        <div className="mx-auto max-w-6xl space-y-7">
          <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((item, idx) => (
              <div
                key={item.label}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex h-full flex-col items-center justify-center rounded-2xl border border-[#243025] bg-[#0d120f] px-4 py-4 text-center shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
              >
                <div className="font-reference text-3xl font-semibold text-[#cfd8c5]">{item.value}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-[#a0ab99]">
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
                } flex h-full flex-col rounded-2xl border border-[#243025] bg-[#0d120f] p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
              >
                <h3 className="font-reference text-xl font-semibold text-white">{card.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">{card.body}</p>
              </div>
            ))}
          </div>

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
                  } flex h-full flex-col rounded-2xl border border-[#243025] bg-[#0d120f] p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
                >
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-[#c8d2bf] bg-[#eef2e9] text-[#203023] shadow-[0_2px_10px_rgba(0,0,0,0.18)]">
                    <IconBadge type={item.icon} />
                  </div>
                  <h3 className="font-reference text-xl font-semibold leading-tight text-white">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">{item.body}</p>
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
                  } flex h-full flex-col rounded-2xl border border-[#243025] bg-[#0d120f] p-4 shadow-[0_10px_20px_rgba(0,0,0,0.22)]`}
                >
                  <div className="mb-4 flex h-7 w-7 items-center justify-center rounded-full bg-[#99aa8e] text-xs font-bold text-white">
                    {step.no}
                  </div>
                  <h3 className="font-reference text-base font-semibold tracking-tight text-white">{step.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">{step.body}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard className="p-5 sm:p-6">
            <SectionTitle
              title="Popular programs"
              subtitle="Browse our OSINT and web application pentesting tracks with staged availability."
            />

            <div className="mt-6 grid auto-rows-fr gap-4 md:grid-cols-2 xl:grid-cols-3">
              {landingPrograms.map((program, idx) => {
                const status = getCourseLaunchStatus(program);
                const bullets = program._bullets || programBulletsForCourse(program);
                const detailsLink = program._fallbackLink || `/courses/${program.id}`;
                return (
                <div
                  key={program.id}
                  className={`hover-lift reveal-up ${
                    idx % 3 === 0 ? "reveal-delay-1" : idx % 3 === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col rounded-2xl border border-[#243025] bg-[#0d120f] p-4 shadow-[0_10px_24px_rgba(0,0,0,0.25)]`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full border border-[#d8e1cf] bg-[#f3f5ee] px-2.5 py-1 text-[11px] font-semibold text-[#62755a]">
                      Course {idx + 1}
                    </span>
                    <span className="rounded-full border border-[#d8e1cf] bg-[#f3f5ee] px-2.5 py-1 text-[11px] font-semibold text-[#62755a]">
                      {program.section_count ?? program.lessons ?? 0} sections
                    </span>
                  </div>

                  <h3 className="mt-4 font-reference text-2xl font-semibold leading-tight text-white">
                    {program.title}
                  </h3>

                  <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">
                    Structured lessons focused on practical workflow and real application in security assessments.
                  </p>

                  <ul className="mt-4 space-y-2 text-sm text-[#b7c0b0]">
                    {bullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-2">
                        <span className="mt-1 inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#d7e0cc]" />
                        </span>
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="mt-auto flex gap-2 pt-4">
                    <Link to={detailsLink} className="flex-1">
                      <button className="w-full rounded-full border border-[#2f3a30] bg-[#111612] px-3 py-2 text-sm font-semibold text-[#d7e0cc] transition hover:bg-[#171d17]">
                        View Details
                      </button>
                    </Link>
                    {status.isLive ? (
                      <Link to={detailsLink} className="flex-1">
                        <button className="w-full rounded-full bg-gradient-to-r from-[#c9d5bd] to-[#8fa184] px-3 py-2 text-sm font-semibold text-[#101410] transition hover:from-[#d7e0cc] hover:to-[#9daf93]">
                          Live
                        </button>
                      </Link>
                    ) : (
                      <button className="flex-1 rounded-full border border-amber-200/20 bg-amber-100/5 px-3 py-2 text-sm font-semibold text-amber-200">
                        Coming Soon
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-2xl border border-[#b9c7ab]/30 bg-gradient-to-r from-[#0f1410] via-[#62755a] to-[#b9c7ab] p-5 text-white shadow-[0_10px_30px_rgba(0,0,0,0.08)]">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="font-reference text-2xl font-semibold">
                    Ready to start your cybersecurity journey?
                  </h3>
                  <p className="mt-2 text-sm text-[#e3ead9]">
                    Join our flagship course and learn OSINT plus web application pentesting with a structured workflow.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link to="/courses">
                    <button className="rounded-full border border-white/60 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">
                      Explore
                    </button>
                  </Link>
                  <Link to={`/courses/${featuredLiveCourse.id}`}>
                    <button className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#62755a] hover:bg-[#f3f5ee]">
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




