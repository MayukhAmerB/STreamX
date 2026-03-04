import { Link } from "react-router-dom";
import { formatINR } from "../utils/currency";
import { getCourseLaunchStatus } from "../utils/courseStatus";

function formatCategory(category) {
  if (category === "web_pentesting") return "Web Pentesting";
  if (category === "osint") return "OSINT";
  return "Cybersecurity";
}

function formatLevel(level) {
  if (!level) return "Program";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export default function CourseCard({ course }) {
  const status = getCourseLaunchStatus(course);
  const categoryLabel = formatCategory(course?.category);
  const levelLabel = formatLevel(course?.level);

  return (
    <article className="hover-lift group relative flex h-full flex-col overflow-hidden rounded-[22px] border border-[#253027] bg-[#0b100d] text-white shadow-[0_20px_48px_rgba(0,0,0,0.28)] transition duration-300 hover:border-[#39453a]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(185,199,171,0.12),transparent_42%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#d8e0cf]/30 to-transparent" />

      <div className="relative aspect-[16/10] bg-[#090b09]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_15%,rgba(185,199,171,0.12),transparent_42%)]" />
        {course.thumbnail ? (
          <img
            src={course.thumbnail}
            alt={course.title}
            className="h-full w-full object-cover opacity-[0.72] transition duration-500 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            No Thumbnail
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#050705] via-black/30 to-black/10" />
        <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/60 to-transparent" />

        <div className="absolute left-4 top-4 right-4 flex items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-white/70 bg-white/90 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-neutral-900 shadow-sm">
              {categoryLabel}
            </span>
            <span className="rounded-full border border-[#d7e0cc]/20 bg-[#0f1410]/85 px-3 py-1 text-[10px] font-semibold tracking-wide text-[#d7e0cc]">
              {levelLabel}
            </span>
          </div>
          <div
            className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.12em] shadow-sm ${
              status.isLive
                ? "border border-[#cde0c0] bg-[#eaf1e2] text-[#213023]"
                : "border border-amber-200/80 bg-amber-50 text-amber-900"
            }`}
          >
            {status.label}
          </div>
        </div>

        <div className="absolute bottom-4 left-4 right-4">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-[#dbe2d2]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[#b9c7ab]" />
            <span>{course.instructor?.full_name || "Instructor"}</span>
          </div>
          <h3 className="line-clamp-2 font-reference text-lg font-semibold leading-tight text-white sm:text-[1.15rem]">
            {course.title}
          </h3>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-5">
        <p className="line-clamp-3 text-sm leading-6 text-[#adb6a7]">
          {course.description || "Cybersecurity course track."}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-[#212b22] bg-[#0f1410] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Modules</div>
            <div className="mt-1 text-sm font-semibold text-[#dde4d3]">
              {course.section_count ?? 0}
            </div>
          </div>
          <div className="rounded-xl border border-[#212b22] bg-[#0f1410] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#7f8b7c]">Access</div>
            <div
              className={`mt-1 text-sm font-semibold ${
                status.isComingSoon ? "text-amber-200" : "text-[#dde4d3]"
              }`}
            >
              {status.isComingSoon ? "Coming Soon" : formatINR(course.price)}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-xs text-[#97a08f]">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[#b9c7ab]" />
          <span>
            {status.isComingSoon
              ? "Join waitlist updates when the track launches."
              : "Enrollment is open for this track."}
          </span>
        </div>

        <div className="mt-auto pt-4">
          <div className="grid grid-cols-2 gap-2">
            <Link
              to={`/courses/${course.id}`}
              className="inline-flex items-center justify-center rounded-full border border-[#2f3a30] bg-[#111612] px-3 py-2.5 text-sm font-semibold text-[#d7e0cc] transition hover:bg-[#171d17]"
            >
              View Details
            </Link>
            {status.isLive ? (
              <Link
                to={`/courses/${course.id}`}
                className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#c9d5bd] to-[#8fa184] px-3 py-2.5 text-sm font-semibold text-[#101410] transition hover:from-[#d7e0cc] hover:to-[#9daf93]"
              >
                Live
              </Link>
            ) : (
              <span className="inline-flex items-center justify-center rounded-full border border-amber-200/20 bg-amber-100/5 px-3 py-2.5 text-sm font-semibold text-amber-200">
                Coming Soon
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
