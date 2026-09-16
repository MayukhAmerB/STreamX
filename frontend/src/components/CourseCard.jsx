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

function getCompactActionLabel(action) {
  const labels = {
    "Access Course": "Access",
    "Apply for Course": "Apply",
    "Buy Course": "Buy Course",
    "Registration Closed": "Closed",
    "Purchase Unavailable": "Unavailable",
    "Coming Soon": "Coming Soon",
  };
  return labels[action?.label] || action?.label;
}

function StarIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-current">
      <path d="m10 1.8 2.45 4.96 5.47.8-3.96 3.85.94 5.45L10 14.3l-4.9 2.56.94-5.45-3.96-3.85 5.47-.8L10 1.8Z" />
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
  const compactActionLabel = getCompactActionLabel(primaryAction);
  const numericPrice = Number(course?.price || 0);
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
  const learningFacts = [hoursLabel, unitLabel, formatLevel(course?.level)].filter(Boolean);
  const unavailableMessage = getPurchaseUnavailableMessage(course);

  useEffect(() => {
    setThumbnailSrc(
      resolveCourseArtwork({ category: courseCategory, thumbnail: courseThumbnail }),
    );
  }, [courseCategory, courseId, courseThumbnail]);

  return (
    <article className="owlcognito-course-card group relative grid min-h-[158px] min-w-0 grid-cols-[108px_minmax(0,1fr)] overflow-hidden rounded-lg border border-white/15 bg-[#070809] text-white shadow-[0_12px_30px_rgba(0,0,0,0.34)] transition duration-300 hover:-translate-y-0.5 hover:border-white/35 hover:shadow-[0_18px_40px_rgba(0,0,0,0.46)] sm:flex sm:h-full sm:min-h-0 sm:flex-col">
      <Link
        to={detailPath}
        aria-label={`View full details for ${safeTitle}`}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
      >
        <span className="sr-only">View full course details</span>
      </Link>

      <div className="relative min-h-[158px] overflow-hidden border-r border-white/10 bg-[#101316] sm:aspect-[16/9] sm:min-h-0 sm:border-b sm:border-r-0">
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
        <div className="absolute inset-x-2 top-2 flex items-center justify-between gap-1.5 sm:inset-x-2.5 sm:top-2.5">
          <span className="owlcognito-course-card-status rounded-full border border-white/25 bg-black/75 px-2 py-1 text-[7px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-md">
            {formatCategory(courseCategory)}
          </span>
          <span className="owlcognito-course-card-status hidden rounded-full border border-white/25 bg-black/75 px-2 py-1 text-[7px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-md sm:inline-flex">
            {course?.registration_closed ? "Previous batch" : status.label}
          </span>
        </div>
      </div>

      <div className="relative flex min-w-0 flex-1 flex-col p-3 sm:p-3.5">
        <h3 className="owlcognito-course-card-title line-clamp-2 font-reference text-[0.93rem] font-semibold leading-[1.22] tracking-[-0.02em] text-white sm:text-[0.98rem]">
          {safeTitle}
        </h3>
        {course?.instructor?.full_name ? (
          <p className="owlcognito-course-card-instructor mt-1 truncate text-[10px] text-[#969EA4]">
            {course.instructor.full_name}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px]" aria-label="Verified course rating">
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

        <p className="owlcognito-course-card-note mt-1.5 line-clamp-1 text-[10px] leading-4 text-[#A8B0B6]" title={learningFacts.join(" | ")}>
          {learningFacts.join(" | ")}
        </p>

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/10 pt-2.5">
          <div className="min-w-0">
            <p className="owlcognito-course-card-price truncate font-reference text-base font-semibold leading-none text-white">
              {numericPrice > 0 ? formatINR(numericPrice) : "Price on request"}
            </p>
          </div>
          {primaryAction.to ? (
            <Link
              to={primaryAction.to}
              aria-label={primaryAction.label}
              className="owlcognito-course-card-action relative z-20 inline-flex min-h-8 shrink-0 items-center justify-center rounded-md border border-white bg-white px-2.5 text-[8px] font-bold uppercase tracking-[0.08em] text-black transition hover:bg-[#E7E7E7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              {compactActionLabel}
            </Link>
          ) : (
            <span
              className="owlcognito-course-card-action-disabled relative z-20 inline-flex min-h-8 max-w-[92px] shrink-0 cursor-not-allowed items-center justify-center rounded-md border border-white/10 bg-white/[0.06] px-2 text-center text-[7px] font-bold uppercase leading-3 tracking-[0.06em] text-[#7F888F]"
              aria-label={primaryAction.label}
              title={unavailableMessage}
            >
              {compactActionLabel}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

export default memo(CourseCard);
