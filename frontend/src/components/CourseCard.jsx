import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getPurchaseUnavailableMessage } from "../utils/courseAccess";
import {
  resolveCourseArtwork,
  resolveCourseArtworkFallback,
} from "../utils/courseArtwork";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";

const DEFAULT_HIGHLIGHTS = [
  { title: "Live classes", description: "Instructor-led guidance and real-time support." },
  { title: "Practical learning", description: "Projects, guided labs, and repeatable workflows." },
  { title: "Recorded access", description: "Revisit published lessons and learning resources." },
  { title: "Certificate", description: "Course completion recognition for successful learners." },
];

function normalizeEnrollmentStatus(value) {
  const raw = String(value || "none").toLowerCase();
  if (raw === "paid" || raw === "approved") return "approved";
  if (raw === "pending") return "pending";
  return "none";
}

function normalizeHighlights(course) {
  const configuredHighlights = Array.isArray(course?.card_highlights)
    ? course.card_highlights
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((title) => ({ title, description: "" }))
    : [];
  if (configuredHighlights.length) return configuredHighlights.slice(0, 4);

  const featureHighlights = Array.isArray(course?.course_card_features)
    ? course.course_card_features
        .map((feature) => ({
          title: String(feature?.title || "").trim(),
          description: String(feature?.description || "").trim(),
        }))
        .filter((feature) => feature.title)
    : [];
  return (featureHighlights.length ? featureHighlights : DEFAULT_HIGHLIGHTS).slice(0, 4);
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
  return category === "web_pentesting" ? "Web & API Pentesting" : "Open Source Intelligence";
}

function formatLevel(level) {
  const value = String(level || "").trim();
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "All levels";
}

function buildCourseFacts(course) {
  const facts = [
    ["Duration", course?.duration],
    ["Schedule", course?.schedule],
    ["Classes", course?.total_classes ? `${course.total_classes} live classes` : ""],
    ["Hours", course?.total_hours_label || (course?.total_hours ? `${course.total_hours} hours` : "")],
    ["Starts", formatDate(course?.start_date)],
    ["Batch", course?.batch_size_label || (course?.batch_size ? `${course.batch_size} seats` : "")],
    ["Level", formatLevel(course?.level)],
    ["Modules", course?.section_count ? `${course.section_count} modules` : ""],
  ];

  return facts.filter(([, value]) => Boolean(value)).slice(0, 4);
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

function CourseCard({ course }) {
  const status = getCourseLaunchStatus(course);
  const courseId = Number(course?.id || 0);
  const courseCategory = course?.category;
  const courseThumbnail = course?.thumbnail;
  const fallbackArtwork = resolveCourseArtworkFallback(courseCategory);
  const [thumbnailSrc, setThumbnailSrc] = useState(() => resolveCourseArtwork(course));
  const safeTitle = course?.card_title || course?.title || "Untitled course";
  const safeDescription =
    course?.card_summary || course?.description || "Professional cybersecurity training program.";
  const highlights = normalizeHighlights(course);
  const facts = buildCourseFacts(course);
  const detailPath = courseId > 0 ? `/courses/${courseId}` : "/courses";
  const hasCourseAccess =
    Boolean(course?.is_enrolled) ||
    normalizeEnrollmentStatus(course?.enrollment_status) === "approved";
  const primaryAction = getPrimaryAction(course, status, hasCourseAccess);
  const numericPrice = Number(course?.price || 0);
  const numericMonthlyPrice = Number(course?.monthly_price || 0);

  useEffect(() => {
    setThumbnailSrc(
      resolveCourseArtwork({ category: courseCategory, thumbnail: courseThumbnail }),
    );
  }, [courseCategory, courseId, courseThumbnail]);

  return (
    <article className="owlcognito-course-card group relative flex h-full min-w-0 flex-col overflow-hidden rounded-[22px] border border-white/15 bg-[#080A0C] text-white shadow-[0_24px_64px_rgba(0,0,0,0.42)] transition duration-300 hover:-translate-y-1 hover:border-white/30 hover:shadow-[0_30px_80px_rgba(0,0,0,0.56)]">
      <Link
        to={detailPath}
        aria-label={`View full details for ${safeTitle}`}
        className="absolute inset-0 z-10 rounded-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-inset"
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
        <div className="absolute inset-0 bg-gradient-to-t from-[#080A0C] via-transparent to-black/10" />
        <div className="absolute left-4 top-4 flex flex-wrap gap-2">
          <span className="rounded-full border border-white/20 bg-black/70 px-3 py-1 text-[9px] font-bold uppercase tracking-[0.17em] text-white backdrop-blur-md">
            {formatCategory(courseCategory)}
          </span>
          <span className="rounded-full border border-white/20 bg-black/70 px-3 py-1 text-[9px] font-bold uppercase tracking-[0.17em] text-white backdrop-blur-md">
            {course?.registration_closed ? "Previous batch" : status.label}
          </span>
        </div>
      </div>

      <div className="relative flex flex-1 flex-col p-5 sm:p-6">
        <div>
          {course?.card_subtitle || course?.batch ? (
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8F9AA3]">
              {course?.card_subtitle || course?.batch}
            </p>
          ) : null}
          <h3 className="owlcognito-course-card-title mt-2 font-reference text-2xl font-semibold leading-tight tracking-[-0.025em] text-white sm:text-[1.7rem]">
            {safeTitle}
          </h3>
          <p className="owlcognito-course-card-description mt-3 line-clamp-3 text-sm leading-6 text-[#AEB5BA]">
            {safeDescription}
          </p>
        </div>

        {facts.length ? (
          <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10">
            {facts.map(([label, value]) => (
              <div key={label} className="min-w-0 bg-[#0D1013] px-3 py-3">
                <dt className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#78838C]">{label}</dt>
                <dd className="mt-1 truncate text-xs font-semibold text-[#EDF0F2]" title={String(value)}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <ul className="mt-5 grid gap-2 sm:grid-cols-2">
          {highlights.map((highlight) => (
            <li key={highlight.title} className="flex items-start gap-2 text-xs leading-5 text-[#C4CACF]">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-white" aria-hidden="true" />
              <span>
                <strong className="block font-semibold text-[#E7EAEC]">{highlight.title}</strong>
                {highlight.description ? (
                  <span className="mt-0.5 block text-[11px] leading-4 text-[#858F96]">
                    {highlight.description}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-auto border-t border-white/10 pt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#77818A]">Course fee</p>
              <p className="mt-1 font-reference text-xl font-semibold text-white">
                {numericPrice > 0 ? formatINR(numericPrice) : "Price on request"}
              </p>
              {course?.installment_payment_enabled && numericMonthlyPrice > 0 ? (
                <p className="mt-1 text-[10px] text-[#8F989F]">or {formatINR(numericMonthlyPrice)} / month</p>
              ) : null}
            </div>
            {course?.instructor?.full_name ? (
              <p className="max-w-[150px] text-right text-[10px] leading-4 text-[#8F989F]">
                Led by <span className="font-semibold text-[#D9DDE0]">{course.instructor.full_name}</span>
              </p>
            ) : null}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            {primaryAction.to ? (
              <Link
                to={primaryAction.to}
                className="owlcognito-course-card-action relative z-20 inline-flex min-h-11 items-center justify-center rounded-lg border border-white bg-white px-4 text-xs font-bold uppercase tracking-[0.12em] text-black transition hover:bg-[#E7E7E7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                {primaryAction.label}
              </Link>
            ) : (
              <span className="owlcognito-course-card-action-disabled relative z-20 inline-flex min-h-11 cursor-not-allowed items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-4 text-center text-[11px] font-bold uppercase tracking-[0.1em] text-[#7F888F]">
                {primaryAction.label}
              </span>
            )}
            <span className="inline-flex min-h-11 items-center justify-center gap-2 px-2 text-[10px] font-bold uppercase tracking-[0.13em] text-[#AEB5BA] transition group-hover:text-white">
              View details <span aria-hidden="true">-&gt;</span>
            </span>
          </div>

          {!status.isComingSoon &&
          !hasCourseAccess &&
          !course?.purchase_available &&
          course?.category !== "web_pentesting" &&
          !course?.registration_closed ? (
            <p className="mt-3 text-xs leading-5 text-[#858E95]">
              {getPurchaseUnavailableMessage(course)}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default memo(CourseCard);
