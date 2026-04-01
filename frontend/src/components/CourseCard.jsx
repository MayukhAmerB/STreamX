import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatINR } from "../utils/currency";
import { getCourseLaunchStatus } from "../utils/courseStatus";

const COURSE_FALLBACK_THUMBNAIL =
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

function normalizeEnrollmentStatus(value) {
  const raw = String(value || "none").toLowerCase();
  if (raw === "paid" || raw === "approved") return "approved";
  if (raw === "pending") return "pending";
  return "none";
}

function CourseCard({ course }) {
  const status = getCourseLaunchStatus(course);
  const categoryLabel = formatCategory(course?.category);
  const levelLabel = formatLevel(course?.level);
  const detailsLink = course?._fallbackLink || `/courses/${course.id}`;
  const [thumbnailSrc, setThumbnailSrc] = useState(course?.thumbnail || "");
  const safeTitle = course?.title || "Untitled course";
  const safeDescription = course?.description || "Cybersecurity course track.";
  const hasCourseAccess =
    Boolean(course?.is_enrolled) || normalizeEnrollmentStatus(course?.enrollment_status) === "approved";

  useEffect(() => {
    setThumbnailSrc(course?.thumbnail || "");
  }, [course?.id, course?.thumbnail]);

  return (
    <article className="hover-lift panel-gradient group relative flex h-full min-h-[560px] self-stretch flex-col overflow-hidden rounded-[22px] border border-black text-white shadow-[0_20px_48px_rgba(0,0,0,0.28)] transition duration-300 hover:border-[#404040] sm:min-h-[620px]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(192,192,192,0.12),transparent_42%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#DCDCDC]/30 to-transparent" />

      <div className="relative h-[200px] bg-[#0A0A0A] sm:h-[230px] lg:h-[260px] xl:h-[280px]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_15%,rgba(192,192,192,0.12),transparent_42%)]" />
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={safeTitle}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover object-center opacity-[0.9] transition duration-500 group-hover:scale-[1.04]"
            onError={() => {
              if (thumbnailSrc !== COURSE_FALLBACK_THUMBNAIL) {
                setThumbnailSrc(COURSE_FALLBACK_THUMBNAIL);
              } else {
                setThumbnailSrc("");
              }
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            No Thumbnail
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#060606]/95 via-black/25 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/72 to-transparent" />

        <div className="absolute left-4 top-4 right-4 flex items-start justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full border border-black bg-white px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-neutral-900 shadow-sm">
              {categoryLabel}
            </span>
            <span className="rounded-full border border-black bg-[#F1F1F1] px-3 py-1 text-[10px] font-semibold tracking-wide text-[#202020]">
              {levelLabel}
            </span>
          </div>
          <div
            className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.12em] shadow-sm ${
              status.isLive
                ? "border border-[#E5E5E5]/80 bg-[linear-gradient(135deg,#FEFEFE_0%,#F5F5F5_55%,#D4D4D4_100%)] text-[#242424]"
                : "border border-[#CCCCCC] bg-[#D9D9D9] text-[#131313]"
            }`}
          >
            {status.label}
          </div>
        </div>

        <div className="absolute bottom-4 left-4 right-4">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-[#DEDEDE]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[#C0C0C0]" />
            <span>{course.instructor?.full_name || "Instructor"}</span>
          </div>
          <h3 className="line-clamp-2 min-h-[3.2rem] max-w-full break-words font-reference text-lg font-semibold leading-tight text-white sm:text-[1.15rem]">
            {safeTitle}
          </h3>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-5">
        <p className="line-clamp-3 min-h-[4.6rem] max-w-full break-words text-sm leading-6 text-[#B2B2B2]">
          {safeDescription}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-black bg-[#F4F4F4] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#5A5A5A]">Modules</div>
            <div className="mt-1 text-sm font-semibold text-[#111111]">
              {course.section_count ?? 0}
            </div>
          </div>
          <div className="rounded-xl border border-black bg-[#F4F4F4] px-3 py-2">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#5A5A5A]">Access</div>
            <div
              className={`mt-1 text-sm font-semibold ${
                status.isComingSoon ? "text-[#2A2A2A]" : "text-[#111111]"
              }`}
            >
              {status.isComingSoon ? "Coming Soon" : formatINR(course.price)}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 text-xs text-[#9B9B9B]">
          <span className="inline-flex h-1.5 w-1.5 rounded-full bg-[#C0C0C0]" />
          <span className="line-clamp-2 min-h-[1.2rem]">
            {status.isComingSoon
              ? "Join waitlist updates when the track launches."
              : "Enrollment is open for this track."}
          </span>
        </div>

        <div className="mt-auto pt-4">
          <div className="grid grid-cols-2 gap-2">
            <Link
              to={detailsLink}
              className="inline-flex items-center justify-center rounded-full border border-black bg-[#141414] px-3 py-2.5 text-sm font-semibold text-[#DBDBDB] transition hover:bg-[#1B1B1B]"
            >
              View Details
            </Link>
            {!status.isComingSoon && hasCourseAccess ? (
              <Link
                to={`/learn/${course.id}`}
                className="glossy inline-flex items-center justify-center rounded-full border border-[#EFE1AF] bg-[linear-gradient(135deg,#FFFBEA_0%,#F6EAC7_55%,#E8D7A6_100%)] px-3 py-2.5 text-sm font-semibold text-[#1A1A1A] shadow-[0_8px_18px_rgba(0,0,0,0.14)] transition hover:bg-[linear-gradient(135deg,#FFFDF2_0%,#F9EFD1_55%,#EEDFB4_100%)]"
              >
                Go to Course
              </Link>
            ) : status.isLive ? (
              <Link
                to={detailsLink}
                className="glossy inline-flex items-center justify-center rounded-full border border-[#EFE1AF] bg-[linear-gradient(135deg,#FFFBEA_0%,#F6EAC7_55%,#E8D7A6_100%)] px-3 py-2.5 text-sm font-semibold text-[#1A1A1A] shadow-[0_8px_18px_rgba(0,0,0,0.14)] transition hover:bg-[linear-gradient(135deg,#FFFDF2_0%,#F9EFD1_55%,#EEDFB4_100%)]"
              >
                Live
              </Link>
            ) : (
              <span className="inline-flex items-center justify-center rounded-full border border-[#B7B7B7] bg-gradient-to-r from-[#CFCFCF] to-[#989898] px-3 py-2.5 text-sm font-semibold text-[#121212] shadow-[0_8px_18px_rgba(0,0,0,0.2)]">
                Coming Soon
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default memo(CourseCard);
