// Rollback landing page (VITE_LANDING_V2=off): the previous design, kept
// for one release so the new page can be switched off without a redeploy of
// the backend. It reads the same data hooks as the new page and, like it,
// never shows made-up live classes or a made-up featured course.
import { Link } from "react-router-dom";
import certificateExcellenceImage from "../../assets/certificate-excellence.webp";
import Button from "../../components/Button";
import { CourseTrackCards } from "../../components/CourseCategorySelector";
import CourseCardRail from "../../components/CourseCardRail";
import HeroCountdown from "../../components/HeroCountdown";
import StoryJourneySection from "../../components/StoryJourneySection";
import YouTubeSection from "../../features/youtube/YouTubeSection";
import { siteStatValues } from "../../marketing/SiteStatStrip";
import { useSiteStats } from "../../marketing/siteStats";
import { useAuth } from "../../hooks/useAuth";
import { selectLandingCourses } from "../../utils/landingCourses";
import { getCourseCategoryPath } from "../../utils/courseCatalog";
import { formatINR } from "../../utils/currency";
import { siteBrand } from "../../config/siteBrand";
import {
  INFO_CARDS as infoCards,
  JOURNEY_STEPS as steps,
  WHY_CHOOSE as whyChoose,
} from "./landingContent";
import {
  countCoursesByTrack,
  liveBroadcastJoinPath,
  selectFeaturedCoursePath,
  useLandingData,
} from "./useLandingData";

const cornerGlowPanelBg = "bg-[#070707]";
const liveClassActionClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-white bg-white px-4 text-sm font-semibold text-black transition hover:border-[#E5E5E5] hover:bg-[#E5E5E5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3] focus-visible:ring-offset-2 focus-visible:ring-offset-black";
const cornerGlowCardBg = "bg-[#0A0A0A]";

const DAY_ABBREVIATIONS = [
  ["Monday", "Mon"],
  ["Tuesday", "Tue"],
  ["Wednesday", "Wed"],
  ["Thursday", "Thu"],
  ["Friday", "Fri"],
  ["Saturday", "Sat"],
  ["Sunday", "Sun"],
];

/** "Friday, Saturday, Sunday" -> "Fri, Sat, Sun" so three facts fit one row on phones. */
function formatScheduleDays(value) {
  const text = String(value || "").trim();
  if (!text) return "Fri, Sat, Sun";
  return DAY_ABBREVIATIONS.reduce((out, [full, short]) => out.replace(new RegExp(full, "gi"), short), text);
}

function formatLiveClassPrice(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return "Free";
  return formatINR(amount);
}

function IconBadge({ type }) {
  if (type === "target") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="owlcognito-icon-badge-glyph h-5 w-5">
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      </svg>
    );
  }

  if (type === "stack") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="owlcognito-icon-badge-glyph h-5 w-5">
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
    <svg viewBox="0 0 24 24" aria-hidden="true" className="owlcognito-icon-badge-glyph h-5 w-5">
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
          {siteBrand.name}
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

function BestsellersSection({ courses }) {
  return (
    <SectionCard className="course-showcase-section p-5 sm:p-7">
      <div className="max-w-3xl">
        <p className="course-showcase-eyebrow flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.24em] text-[#969EA4] sm:text-xs">
          <span className="h-px w-10 bg-white/65" aria-hidden="true" />
          Our training program
        </p>
        <h2 className="course-showcase-heading mt-5 font-reference text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl lg:text-5xl">
          Bestsellers
        </h2>
        <p className="course-showcase-summary mt-3 max-w-2xl text-sm leading-7 text-[#A7A7A7] sm:text-base">
          Compare active professional programs, verified learner ratings, curriculum depth,
          and learning formats before opening the full course page.
        </p>
      </div>

      {courses.length ? (
        <CourseCardRail courses={courses} />
      ) : (
        <p className="mt-6 rounded-xl border border-white/10 bg-[#090909] px-4 py-3 text-sm text-[#AAAAAA]">
          Live courses are being updated. Submit an enrollment enquiry and our team will contact you.
        </p>
      )}
    </SectionCard>
  );
}

export default function LandingPageV1() {
  const isOwlCognito = siteBrand.id === "owlcognito";
  const { isAuthenticated } = useAuth();
  const stats = siteStatValues(useSiteStats().items);
  const { catalog, liveClasses, liveBroadcast: heroLiveBroadcast } = useLandingData(isAuthenticated);
  const catalogCourses = catalog.courses;
  const landingPrograms = liveClasses.items;
  const landingLiveClassesError =
    liveClasses.status === "error" ? "The live class feed is unavailable right now. Please try again shortly." : "";
  const featuredLiveCourseLink = selectFeaturedCoursePath(catalogCourses);
  const heroCourseCounts = countCoursesByTrack(catalogCourses);
  const heroLiveBroadcastJoinPath = liveBroadcastJoinPath(heroLiveBroadcast);
  const landingLiveCourses = selectLandingCourses(catalogCourses);


  return (
    <div
      className={`relative ${
        isOwlCognito
          ? "owlcognito-landing bg-[#fbfaff] text-[#241344]"
          : "bg-[#030303] text-[#F6F6F6]"
      }`}
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        <div
          className={`absolute inset-0 ${
            isOwlCognito
              ? "bg-[linear-gradient(180deg,#ffffff_0%,#f7f4ff_48%,#fbfaff_100%)]"
              : "bg-[linear-gradient(180deg,#020202_0%,#050505_52%,#030303_100%)]"
          }`}
        />
        <div
          className={`absolute inset-0 [background-size:72px_72px] ${
            isOwlCognito
              ? "opacity-40 [background-image:linear-gradient(rgba(109,40,217,0.055)_1px,transparent_1px),linear-gradient(90deg,rgba(109,40,217,0.055)_1px,transparent_1px)]"
              : "opacity-20 [background-image:linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)]"
          }`}
        />
      </div>

      <section
        className="landing-hero relative z-10 overflow-hidden border-b border-white/10 bg-black px-4"
      >
        <div aria-hidden="true" className="hero-atmosphere pointer-events-none absolute inset-0">
          <div className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:64px_64px]" />
          <div className="absolute -left-24 top-20 h-[360px] w-[520px] -rotate-12 bg-[linear-gradient(110deg,rgba(255,255,255,0.08),transparent_68%)] blur-3xl" />
          <div className="absolute right-[4%] top-[4%] h-80 w-80 bg-white/[0.04] blur-[120px]" />
        </div>

        <div className="relative mx-auto max-w-[1320px] pt-7 sm:pt-9 lg:pt-10">
          <div className="grid min-h-0 items-center gap-7 pb-7 sm:min-h-[470px] lg:grid-cols-[0.78fr_1.22fr] lg:gap-9 xl:gap-12">
            <div className="reveal-up py-1 sm:py-2 lg:py-4">
              <p className="hero-eyebrow flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.24em] text-[#B8C0C5] sm:text-xs">
                <span className="h-px w-10 bg-white/65" aria-hidden="true" />
                Professional cybersecurity training
              </p>

              {heroLiveBroadcast ? (
                <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-red-400/30 bg-red-950/35 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-red-100">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
                  Live now
                </div>
              ) : null}

              <h1 className="hero-heading mt-5 max-w-[570px] font-reference text-[clamp(2.35rem,10vw,4rem)] font-semibold leading-[0.94] tracking-[-0.05em] text-white sm:text-[clamp(3rem,4.8vw,4rem)]">
                <span className="block">Learn practical</span>
                <span className="block">cyber skills.</span>
                <span className="mt-2 block text-[0.56em] leading-[1.02] tracking-[-0.035em] text-[#AEB7BD]">Build real capability.</span>
              </h1>

              <p className="hero-summary mt-5 max-w-xl text-sm leading-6 text-[#9CA4AA] sm:text-[0.95rem] sm:leading-7">
                Learn OSINT, reconnaissance, and web application testing through structured live
                programs, protected recordings, and practical instructor guidance.
              </p>

              <ul className="hero-trust mt-5 flex max-w-xl flex-wrap gap-x-5 gap-y-2 text-[9px] font-bold uppercase tracking-[0.14em] text-[#C6CCD0] sm:text-[10px]">
                {["Live mentorship", "Protected recordings", "Verified certificates"].map((label) => (
                  <li key={label} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 bg-white" aria-hidden="true" />
                    {label}
                  </li>
                ))}
              </ul>

              {heroLiveBroadcast ? (
                <Link
                  to={isAuthenticated ? heroLiveBroadcastJoinPath : "/login"}
                  className="mt-6 hidden w-full max-w-xl items-center justify-between gap-4 rounded-xl border border-red-400/45 bg-red-600 px-5 py-4 sm:flex text-left text-white shadow-[0_20px_48px_rgba(220,38,38,0.3)] transition hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
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

              <div className="mt-6 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap">
                <Link
                  to="/courses"
                  className="hero-primary-action inline-flex min-h-12 items-center justify-center rounded-lg bg-white px-6 text-sm font-semibold text-black transition hover:bg-[#E5E5E5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                >
                  Browse Courses
                </Link>
                <Link
                  to={isAuthenticated ? "/console" : "/login"}
                  className="hero-secondary-action inline-flex min-h-12 items-center justify-center rounded-lg border border-white/20 bg-[#090909] px-6 text-sm font-semibold text-white transition hover:border-white/40 hover:bg-[#111111] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3]"
                >
                  {isAuthenticated ? "Console" : "Get Started"}
                </Link>
              </div>
            </div>

            <div className="hero-program-panel reveal-up reveal-delay-1 relative bg-transparent p-0 sm:rounded-[22px] sm:border sm:border-white/12 sm:bg-white/[0.035] sm:p-4 sm:shadow-[0_30px_90px_rgba(0,0,0,0.38)] sm:backdrop-blur-sm">
              {heroLiveBroadcast ? (
                <Link
                  to={isAuthenticated ? heroLiveBroadcastJoinPath : "/login"}
                  className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-red-400/45 bg-red-600 px-4 py-3 text-white shadow-[0_16px_36px_rgba(220,38,38,0.24)] sm:hidden"
                >
                  <span className="text-[10px] font-extrabold uppercase tracking-[0.16em]">
                    Class is live
                  </span>
                  <span className="text-xs font-extrabold uppercase">Join now -&gt;</span>
                </Link>
              ) : null}

              <div className="mb-4 border-t border-white/10 pt-6 sm:mb-3 sm:flex sm:items-end sm:justify-between sm:gap-4 sm:border-b sm:border-t-0 sm:pb-3 sm:pt-0">
                <div>
                  <p className="hero-program-kicker text-[11px] font-bold uppercase tracking-[0.24em] text-[#A3A3A3] sm:text-[10px] sm:tracking-[0.22em]">Featured programs</p>
                  <h2 className="hero-program-title mt-2 max-w-[430px] font-reference text-[clamp(1.6rem,7vw,2.2rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-white sm:mt-1 sm:max-w-none sm:text-xl sm:leading-normal sm:tracking-[-0.025em]">Choose your training path</h2>
                </div>
                <div className="mt-3 flex items-center gap-4 sm:mt-0 sm:block">
                  <span className="hero-program-count shrink-0 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A3A3A3] sm:tracking-[0.14em]">2 professional tracks</span>
                  <span className="h-px flex-1 bg-white/25 sm:hidden" aria-hidden="true" />
                </div>
              </div>
              <CourseTrackCards
                counts={heroCourseCounts}
                getHref={getCourseCategoryPath}
                compactMobile
              />
            </div>
          </div>

          <HeroCountdown courses={catalogCourses} />
        </div>
      </section>

      <div className="relative z-10 px-4 pb-20 pt-8">
        <div className="mx-auto max-w-6xl space-y-8">
          <YouTubeSection />

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
                  Successful learners receive an official Certificate of Excellence in this
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
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8C8C8C]">
                        {label}
                      </dt>
                      <dd className="mt-1.5 text-xs font-semibold text-[#D4D4D4]">{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <figure className="owlcognito-certificate-figure flex min-w-0 items-center bg-[#0B0B0B] p-3 sm:p-5 lg:p-6">
                <div className="owlcognito-certificate-image-frame w-full overflow-hidden rounded-xl border border-white/15 bg-[#151515] shadow-[0_24px_70px_rgba(0,0,0,0.5)]">
                  <img
                    src={certificateExcellenceImage}
                    alt={`${siteBrand.name} Certificate of Excellence format`}
                    width="1600"
                    height="900"
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

          {stats.length ? (
          <div className="grid overflow-hidden rounded-[20px] border border-white/10 bg-[#070707] sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((item, idx) => (
              <div
                key={item.label}
                className={`reveal-up ${
                  idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                } flex min-h-28 h-full flex-col justify-center border-b border-white/10 px-5 py-5 last:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0`}
              >
                <div className="font-reference text-3xl font-semibold text-white">{item.value}</div>
                <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8F8F8F]">
                  {item.label}
                </div>
              </div>
            ))}
          </div>
          ) : null}

          <section id="about" className="scroll-mt-24 rounded-[22px] border border-white/10 bg-[#070707] p-5 sm:p-7">
            <SectionTitle
              title="Built for disciplined learning"
              subtitle="A focused cybersecurity education platform for students who value method, evidence, and responsible practice."
            />
            <div className="mt-7 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:auto-rows-fr lg:grid-cols-3">
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
              title={`Why learners choose ${siteBrand.name}`}
              subtitle="Cybersecurity training depth with a modern online learning experience focused on professional execution."
            />
            <div className="mt-6 grid gap-4 lg:auto-rows-fr lg:grid-cols-3">
              {whyChoose.map((item, idx) => (
                <div
                  key={item.title}
                  className={`owlcognito-live-card hover-lift reveal-up ${
                    idx === 0 ? "reveal-delay-1" : idx === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } flex h-full flex-col rounded-2xl border border-white/10 bg-[#0A0A0A] p-5`}
                >
                  <div className="owlcognito-icon-badge mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-[#050505] text-[#CFCFCF]">
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
            <div className="mt-6 grid gap-4 lg:auto-rows-fr lg:grid-cols-3">
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

          <BestsellersSection courses={landingLiveCourses} />

          <SectionCard className="p-5 sm:p-6">
            <SectionTitle
              title="Live classes"
              subtitle="Current live OSINT classes: three sessions a week, each included with its professional training program."
            />

            {landingLiveClassesError ? (
              <div className="mt-6 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
                {landingLiveClassesError}
              </div>
            ) : null}

            <div className="mt-6 grid gap-4 md:auto-rows-fr md:grid-cols-2 xl:grid-cols-3">
              {landingPrograms.map((program, idx) => {
                const enrollmentStatus = String(program.enrollment_status || "").toLowerCase();
                return (
                <div
                  key={program.id}
                  className={`hover-lift reveal-up ${
                    idx % 3 === 0 ? "reveal-delay-1" : idx % 3 === 1 ? "reveal-delay-2" : "reveal-delay-3"
                  } owlcognito-live-card flex h-full flex-col rounded-2xl border border-white/10 ${cornerGlowCardBg} p-5 transition-colors hover:border-white/20`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full border border-white/10 bg-[#050505] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#B5B5B5]">
                      Live class
                    </span>
                    <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300">
                      Live
                    </span>
                  </div>

                  <h3 className="mt-4 font-reference text-2xl font-semibold leading-tight text-white">
                    {program.title}
                  </h3>

                  <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                    {program.description || "OSINT live class track with guided progression."}
                  </p>

                  <div className="mt-4 grid auto-rows-fr grid-cols-3 gap-2">
                    <div className="owlcognito-live-stat h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Schedule</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {formatScheduleDays(program.schedule_days)}
                      </div>
                    </div>
                    <div className="owlcognito-live-stat h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">Duration</div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.class_duration_minutes
                          ? `${program.class_duration_minutes} min`
                          : "1 hour"}
                      </div>
                    </div>
                    <div className="owlcognito-live-stat h-full rounded-xl border border-white/10 bg-[#060606] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-[0.14em] text-[#868686]">
                        {program.linked_course_id ? "Access" : "Price"}
                      </div>
                      <div className="mt-1 text-xs font-semibold text-[#E0E0E0]">
                        {program.linked_course_id ? "Included with course" : formatLiveClassPrice(program.price)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <span className="rounded-full border border-white/10 bg-[#060606] px-3 py-1 text-xs font-semibold text-[#AAAAAA]">
                      {(program.enrollment_count ?? 0)} enrolled
                    </span>
                    {program.linked_course_id ? (
                      <Link
                        to={`/courses/${program.linked_course_id}`}
                        className="inline-flex min-h-7 items-center rounded-full border border-white/10 bg-[#060606] px-3 py-1 text-xs font-semibold text-[#D4D4D4] transition hover:border-white/25 hover:text-white"
                      >
                        Included with {program.linked_course_title || "parent course"}
                      </Link>
                    ) : (
                      <span className="rounded-full border border-white/10 bg-[#060606] px-3 py-1 text-xs font-semibold text-[#AAAAAA]">
                        Standalone class
                      </span>
                    )}
                  </div>

                  <div className="mt-auto pt-4">
                    {program.is_enrolled || enrollmentStatus === "approved" ? (
                      <Link
                        to={
                          program.linked_course_id
                            ? `/courses/${program.linked_course_id}/live`
                            : "/courses?view=owned"
                        }
                        className={liveClassActionClass}
                      >
                        Open live class
                      </Link>
                    ) : enrollmentStatus === "pending" ? (
                      <Button className="w-full" disabled>
                        Request pending
                      </Button>
                    ) : program.linked_course_id ? (
                      <Link to={`/courses/${program.linked_course_id}`} className={liveClassActionClass}>
                        View the course
                      </Link>
                    ) : (
                      <Button className="w-full" disabled>
                        Enrollment closed
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
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <Link
                    to="/courses"
                    className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/15 px-5 text-sm font-semibold text-white transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3]"
                  >
                    Explore courses
                  </Link>
                  <Link
                    to={featuredLiveCourseLink}
                    className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-black transition hover:bg-[#E8E8E8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
                  >
                    Join now
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
