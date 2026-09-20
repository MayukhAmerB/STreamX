import { Link } from "react-router-dom";

import osintTrackLogo from "../assets/course-track-osint.png";
import pentestingTrackLogo from "../assets/course-track-pentesting.png";

export const COURSE_TRACKS = [
  {
    category: "osint",
    title: "OSINT",
    subtitle: "Open Source Intelligence",
    description:
      "Structured intelligence training for research, verification, digital investigations, and real-world analysis.",
    image: osintTrackLogo,
  },
  {
    category: "web_pentesting",
    title: "Pentesting",
    subtitle: "Web Application & API Security",
    description:
      "Practical security training from core testing workflows to advanced web and API exploitation techniques.",
    image: pentestingTrackLogo,
  },
];

function CourseTrackCardContent({ track, selected, count, compactMobile = false }) {
  const bodyClassName = compactMobile
    ? "relative flex h-full min-h-[310px] flex-col p-4 sm:min-h-[420px] sm:p-7"
    : "relative flex h-full min-h-[390px] flex-col p-5 sm:min-h-[420px] sm:p-7";
  const logoClassName = compactMobile
    ? "mt-1 flex h-24 items-center justify-center overflow-hidden sm:mt-2 sm:h-40"
    : "mt-2 flex h-36 items-center justify-center overflow-hidden sm:h-40";

  return (
    <>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_22%,rgba(255,255,255,0.09),transparent_38%)] opacity-80" />
      <div className={bodyClassName}>
        <div className="flex items-center justify-between">
          <span className={`rounded-full border border-white/20 bg-black/60 font-semibold uppercase text-[#D6D6D6] ${
            compactMobile
              ? "px-2.5 py-1 text-[8px] tracking-[0.16em] sm:px-3 sm:text-[10px] sm:tracking-[0.2em]"
              : "px-3 py-1 text-[10px] tracking-[0.2em]"
          }`}>
            {selected ? "Selected track" : "Professional track"}
          </span>
          <span className={`${compactMobile ? "text-[9px] sm:text-[11px]" : "text-[11px]"} font-medium text-[#9A9A9A]`}>
            {count} course{count === 1 ? "" : "s"}
          </span>
        </div>

        <div className={logoClassName}>
          <img
            src={track.image}
            alt={`${track.title} course track logo`}
            className={`h-full w-full object-contain transition duration-500 ${
              compactMobile
                ? "scale-[1.68] group-hover:scale-[1.76] sm:scale-[1.85] sm:group-hover:scale-[1.95]"
                : "scale-[1.85] group-hover:scale-[1.95]"
            }`}
          />
        </div>

        <div className="mt-auto">
          <h3 className={`font-reference font-semibold uppercase text-white sm:text-3xl ${
            compactMobile ? "text-xl tracking-[0.13em]" : "text-2xl tracking-[0.16em]"
          }`}>
            {track.title}
          </h3>
          <p className={`mt-2 font-semibold uppercase text-[#A7A7A7] sm:text-[11px] sm:tracking-[0.2em] ${
            compactMobile ? "text-[9px] tracking-[0.15em]" : "text-[11px] tracking-[0.2em]"
          }`}>
            {track.subtitle}
          </p>
          <div className={`${compactMobile ? "my-3 sm:my-5" : "my-5"} h-px bg-white/15`} />
          <p className={`${compactMobile ? "min-h-[3rem] text-xs leading-5 sm:min-h-[3.75rem] sm:text-sm sm:leading-6" : "min-h-[3.75rem] text-sm leading-6"} text-[#B8B8B8]`}>
            {track.description}
          </p>
          <div className={`${compactMobile ? "mt-3 pt-3 sm:mt-5 sm:pt-4" : "mt-5 pt-4"} flex items-center justify-between border-t border-white/15`}>
            <span className={`${compactMobile ? "text-[9px] tracking-[0.16em] sm:text-[11px] sm:tracking-[0.2em]" : "text-[11px] tracking-[0.2em]"} font-semibold uppercase text-white`}>
              View all courses
            </span>
            <span className={`flex items-center justify-center rounded-full border border-white/35 text-white transition group-hover:bg-white group-hover:text-black ${
              compactMobile ? "h-8 w-8 text-base sm:h-10 sm:w-10 sm:text-xl" : "h-10 w-10 text-xl"
            }`} aria-hidden="true">
              &rarr;
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

export function CourseTrackCards({
  selectedCategory = "",
  counts = {},
  onSelect = () => {},
  getHref,
  compactMobile = false,
}) {
  return (
    <div className="mt-7 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 lg:gap-6">
      {COURSE_TRACKS.map((track) => {
        const selected = selectedCategory === track.category;
        const count = Number(counts[track.category] || 0);
        const mobileWidthClass = compactMobile ? "min-w-[72%] rounded-[20px]" : "min-w-[82%] rounded-[24px]";
        const className = `group relative ${mobileWidthClass} snap-start overflow-hidden border bg-[#090A0B] text-left transition duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:min-w-0 sm:rounded-[24px] ${
          selected
            ? "border-white/75 shadow-[0_22px_55px_rgba(0,0,0,0.55)]"
            : "border-white/20 hover:-translate-y-1 hover:border-white/45"
        }`;
        const content = (
          <CourseTrackCardContent
            track={track}
            selected={selected}
            count={count}
            compactMobile={compactMobile}
          />
        );
        const href = typeof getHref === "function" ? getHref(track.category) : "";

        return href ? (
          <Link
            key={track.category}
            to={href}
            aria-label={`View ${track.title} courses`}
            className={className}
          >
            {content}
          </Link>
        ) : (
          <button
            key={track.category}
            type="button"
            aria-pressed={selected}
            aria-controls="course-category-results"
            onClick={() => onSelect(track.category)}
            className={className}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

export default function CourseCategorySelector({
  selectedCategory = "",
  counts = {},
  onSelect = () => {},
  getHref,
}) {
  return (
    <section className="mb-8 overflow-hidden rounded-[28px] border border-white/10 bg-[#050505] px-4 py-7 shadow-[0_30px_90px_rgba(0,0,0,0.34)] sm:px-7 sm:py-9 lg:px-10">
      <div className="relative">
        <div className="max-w-3xl">
          <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#9B9B9B]">
            Featured Programs
          </div>
          <h2 className="mt-3 font-reference text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl lg:text-5xl">
            Choose your training path
          </h2>
          <div className="mt-5 flex items-center gap-4 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#A8A8A8]">
            <span>2 professional tracks</span>
            <span className="h-px flex-1 bg-gradient-to-r from-white/35 to-transparent" />
          </div>
        </div>

        <CourseTrackCards
          selectedCategory={selectedCategory}
          counts={counts}
          onSelect={onSelect}
          getHref={getHref}
        />

        <div className="mt-5 flex justify-center gap-2 sm:hidden" aria-hidden="true">
          {COURSE_TRACKS.map((track) => (
            <span
              key={track.category}
              className={`h-2 rounded-full transition-all ${
                selectedCategory === track.category ? "w-6 bg-white" : "w-2 bg-white/20"
              }`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
