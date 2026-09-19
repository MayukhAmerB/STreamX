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

function CourseTrackCardContent({ track, selected, count }) {
  return (
    <>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_22%,rgba(255,255,255,0.09),transparent_38%)] opacity-80" />
      <div className="relative flex h-full min-h-[390px] flex-col p-5 sm:min-h-[420px] sm:p-7">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-white/20 bg-black/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#D6D6D6]">
            {selected ? "Selected track" : "Professional track"}
          </span>
          <span className="text-[11px] font-medium text-[#9A9A9A]">
            {count} course{count === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mt-2 flex h-36 items-center justify-center overflow-hidden sm:h-40">
          <img
            src={track.image}
            alt={`${track.title} course track logo`}
            className="h-full w-full scale-[1.85] object-contain transition duration-500 group-hover:scale-[1.95]"
          />
        </div>

        <div className="mt-auto">
          <h3 className="font-reference text-2xl font-semibold uppercase tracking-[0.16em] text-white sm:text-3xl">
            {track.title}
          </h3>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#A7A7A7]">
            {track.subtitle}
          </p>
          <div className="my-5 h-px bg-white/15" />
          <p className="min-h-[3.75rem] text-sm leading-6 text-[#B8B8B8]">
            {track.description}
          </p>
          <div className="mt-5 flex items-center justify-between border-t border-white/15 pt-4">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white">
              View all courses
            </span>
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/35 text-xl text-white transition group-hover:bg-white group-hover:text-black" aria-hidden="true">
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
}) {
  return (
    <div className="mt-7 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 lg:gap-6">
      {COURSE_TRACKS.map((track) => {
        const selected = selectedCategory === track.category;
        const count = Number(counts[track.category] || 0);
        const className = `group relative min-w-[82%] snap-start overflow-hidden rounded-[24px] border bg-[#090A0B] text-left transition duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:min-w-0 ${
          selected
            ? "border-white/75 shadow-[0_22px_55px_rgba(0,0,0,0.55)]"
            : "border-white/20 hover:-translate-y-1 hover:border-white/45"
        }`;
        const content = (
          <CourseTrackCardContent track={track} selected={selected} count={count} />
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
