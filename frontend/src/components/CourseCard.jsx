import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getPurchaseUnavailableMessage } from "../utils/courseAccess";
import {
  resolveCourseArtwork,
  resolveCourseArtworkFallback,
} from "../utils/courseArtwork";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";

function normalizeEnrollmentStatus(value) {
  const raw = String(value || "none").toLowerCase();
  if (raw === "paid" || raw === "approved") return "approved";
  if (raw === "pending") return "pending";
  return "none";
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCategory(category) {
  return category === "web_pentesting" ? "Pentesting" : "OSINT";
}

function formatLevel(level) {
  const value = String(level || "").trim();
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "All levels";
}

function getPrimaryAction(course, status, hasCourseAccess) {
  const id = Number(course?.id || 0);
  if (status.isComingSoon || id <= 0) return { label: "Coming Soon", disabled: true };
  if (hasCourseAccess) return { label: "Access Course", to: `/learn/${id}` };
  if (course?.registration_closed) return { label: "Registration Closed", disabled: true };
  if (course?.category === "web_pentesting") {
    return { label: "Apply for Course", to: `/courses/${id}/register` };
  }
  if (course?.purchase_available) return { label: "Buy Course", to: `/courses/${id}/payment` };
  return { label: "Purchase Unavailable", disabled: true };
}

function StarIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
      <path d="m10 1.8 2.45 4.96 5.47.8-3.96 3.85.94 5.45L10 14.3l-4.9 2.56.94-5.45-3.96-3.85 5.47-.8L10 1.8Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-[1.7]">
      <path d="M5 12h13M13 7l5 5-5 5" />
    </svg>
  );
}

function CourseCard({ course }) {
  const status = getCourseLaunchStatus(course);
  const courseId = Number(course?.id || 0);
  const courseCategory = course?.category;
  const courseThumbnail = course?.thumbnail;
  const fallbackArtwork = resolveCourseArtworkFallback(courseCategory);
  const [thumbnailSrc, setThumbnailSrc] = useState(() => resolveCourseArtwork(course));
  const safeTitle = course?.card_title || course?.title || "Untitled course";
  const detailPath = courseId > 0 ? `/courses/${courseId}` : "/courses";
  const hasCourseAccess =
    Boolean(course?.is_enrolled) ||
    normalizeEnrollmentStatus(course?.enrollment_status) === "approved";
  const primaryAction = getPrimaryAction(course, status, hasCourseAccess);
  const numericPrice = Number(course?.price || 0);
  const numericMonthlyPrice = Number(course?.monthly_price || 0);
  const parsedReviewCount = Number(course?.review_count || 0);
  const reviewCount = Number.isFinite(parsedReviewCount)
    ? Math.max(0, Math.trunc(parsedReviewCount))
    : 0;
  const averageRating = Number(course?.average_rating);
  const hasRating = reviewCount > 0 && Number.isFinite(averageRating);
  const hoursLabel = course?.total_hours_label ||
    (Number(course?.total_hours || 0) > 0 ? `${course.total_hours} total hours` : course?.duration || "");
  const unitLabel = Number(course?.lecture_count || 0) > 0
    ? `${course.lecture_count} lectures`
    : Number(course?.total_classes || 0) > 0
      ? `${course.total_classes} live classes`
      : Number(course?.section_count || 0) > 0
        ? `${course.section_count} modules`
        : "";
  const startLabel = formatDate(course?.start_date);
  const learningFacts = [hoursLabel, unitLabel, formatLevel(course?.level)].filter(Boolean);

  useEffect(() => {
    setThumbnailSrc(
      resolveCourseArtwork({ category: courseCategory, thumbnail: courseThumbnail }),
    );
  }, [courseCategory, courseId, courseThumbnail]);

  return (
    <article className="owlcognito-course-card group relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-white/15 bg-[#070809] text-white shadow-[0_16px_38px_rgba(0,0,0,0.36)] transition duration-300 hover:-translate-y-1 hover:border-white/35 hover:shadow-[0_22px_54px_rgba(0,0,0,0.5)]">
      <Link
        to={detailPath}
        aria-label={`View full details for ${safeTitle}`}
        className="absolute inset-0 z-10 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
      >
        <span className="sr-only">View full course details</span>
      </Link>

      <div className="relative aspect-[16/9] overflow-hidden border-b border-white/10 bg-[#101316]">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={course?.image_alt || `${safeTitle} course artwork`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]"
            onError={() => {
              if (fallbackArtwork && thumbnailSrc !== fallbackArtwork) {
                setThumbnailSrc(fallbackArtwork);
              } else {
                setThumbnailSrc("");
              }
            }}
          />
        ) : (
          <div className="h-full w-full bg-[radial-gradient(circle_at_75%_25%,rgba(255,255,255,0.13),transparent_34%),linear-gradient(135deg,#11161A,#050607)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/10" />
        <div className="absolute inset-x-3 top-3 flex items-center justify-between gap-2">
          <span className="owlcognito-course-card-status rounded-full border border-white/25 bg-black/75 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.16em] text-white backdrop-blur-md">
            {formatCategory(courseCategory)}
          </span>
          <span className="owlcognito-course-card-status rounded-full border border-white/25 bg-black/75 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.16em] text-white backdrop-blur-md">
            {course?.registration_closed ? "Previous batch" : status.label}
          </span>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-3.5 sm:p-4">
        <h3 className="owlcognito-course-card-title line-clamp-2 font-reference text-base font-semibold leading-[1.24] tracking-[-0.02em] text-white sm:text-[1.05rem]">
          {safeTitle}
        </h3>
        {course?.instructor?.full_name ? (
          <p className="owlcognito-course-card-instructor mt-1 text-[11px] text-[#969EA4]">
            {course.instructor.full_name}
          </p>
        ) : null}

        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" aria-label="Verified course rating">
          <span className="inline-flex items-center gap-1 font-bold text-amber-400">
            <span className="text-[#F4A62A]">{hasRating ? averageRating.toFixed(1) : "New"}</span>
            <span className="text-amber-400"><StarIcon /></span>
          </span>
          <Link
            to={`${detailPath}#reviews`}
            className="owlcognito-course-card-note relative z-20 text-[#A8B0B6] underline-offset-2 transition hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            aria-label={`${reviewCount} verified reviews for ${safeTitle}`}
          >
            ({reviewCount} {reviewCount === 1 ? "review" : "reviews"})
          </Link>
        </div>

        <p className="owlcognito-course-card-note mt-2 line-clamp-2 text-[11px] leading-4 text-[#A8B0B6]">
          {learningFacts.join(" | ")}
        </p>

        {course?.schedule || startLabel ? (
          <p className="owlcognito-course-card-note mt-1.5 line-clamp-1 text-[10px] leading-4 text-[#858E95]" title={[startLabel ? `Starts ${startLabel}` : "", course?.schedule || ""].filter(Boolean).join(" | ")}>
            {[startLabel ? `Starts ${startLabel}` : "", course?.schedule || ""].filter(Boolean).join(" | ")}
          </p>
        ) : null}

        <div className="mt-auto flex items-end justify-between gap-3 border-t border-white/10 pt-3">
          <div className="min-w-0 flex-1">
            <p className="owlcognito-course-card-price font-reference text-lg font-semibold leading-none text-white">
              {numericPrice > 0 ? formatINR(numericPrice) : "Price on request"}
            </p>
            {course?.installment_payment_enabled && numericMonthlyPrice > 0 ? (
              <p className="owlcognito-course-card-note mt-1 text-[9px] text-[#8F989F]">
                or {formatINR(numericMonthlyPrice)} / month
              </p>
            ) : null}
          </div>
          <Link
            to={detailPath}
            aria-label={`Open ${safeTitle}`}
            className="owlcognito-course-card-arrow relative z-20 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/30 text-white transition group-hover:border-white group-hover:bg-white group-hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ArrowIcon />
          </Link>
        </div>

        <div className="mt-3">
          {primaryAction.to ? (
            <Link
              to={primaryAction.to}
              className="owlcognito-course-card-action relative z-20 inline-flex min-h-9 w-full items-center justify-center rounded-md border border-white bg-white px-3 text-[10px] font-bold uppercase tracking-[0.1em] text-black transition hover:bg-[#E7E7E7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {primaryAction.label}
            </Link>
          ) : (
            <span className="owlcognito-course-card-action-disabled relative z-20 inline-flex min-h-9 w-full cursor-not-allowed items-center justify-center rounded-md border border-white/10 bg-white/[0.06] px-3 text-center text-[9px] font-bold uppercase tracking-[0.08em] text-[#7F888F]">
              {primaryAction.label}
            </span>
          )}
        </div>

        {!status.isComingSoon &&
        !hasCourseAccess &&
        !course?.purchase_available &&
        course?.category !== "web_pentesting" &&
        !course?.registration_closed ? (
          <p className="owlcognito-course-card-note mt-2 line-clamp-2 text-[10px] leading-4 text-[#858E95]">
            {getPurchaseUnavailableMessage(course)}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export default memo(CourseCard);
