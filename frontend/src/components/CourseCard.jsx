import { memo, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPurchaseUnavailableMessage } from "../utils/courseAccess";
import { getCourseLaunchStatus } from "../utils/courseStatus";

const COURSE_FALLBACK_THUMBNAIL =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const DEFAULT_CARD_FEATURES = [
  {
    icon: "live",
    title: "Live Sessions",
    description: "Attend interactive live classes with real-time guidance from industry experts.",
  },
  {
    icon: "chat",
    title: "Live Broadcast Chat Room",
    description: "Get your doubts cleared instantly in our live chat room during sessions.",
  },
  {
    icon: "recording",
    title: "Lifetime Recorded Access",
    description: "Access all recorded sessions and materials for lifetime anytime, anywhere.",
  },
  {
    icon: "check",
    title: "3 Exclusive Live Q&A Sessions",
    description: "Join 3 exclusive live Q&A sessions with the Al Syed team.",
  },
  {
    icon: "certificate",
    title: "Course Completion Certificate",
    description: "Get a verified certificate upon successful completion of the training.",
  },
  {
    icon: "support",
    title: "24x7 Team Chat Support",
    description: "Round-the-clock support from our team whenever you need help.",
  },
];

function normalizeEnrollmentStatus(value) {
  const raw = String(value || "none").toLowerCase();
  if (raw === "paid" || raw === "approved") return "approved";
  if (raw === "pending") return "pending";
  return "none";
}

function normalizeFeatures(value) {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_CARD_FEATURES;

  const features = value
    .slice(0, 8)
    .map((feature) => ({
      icon: String(feature?.icon || "check").toLowerCase(),
      title: String(feature?.title || "").trim(),
      description: String(feature?.description || "").trim(),
    }))
    .filter((feature) => feature.title && feature.description);

  return features.length ? features : DEFAULT_CARD_FEATURES;
}

function FeatureIcon({ type }) {
  if (type === "certificate") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h10l2 2v9a6 6 0 0 0-8 5H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path d="M14 3v4h4M15 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0Zm1 2v3l2-1 2 1v-3" />
      </svg>
    );
  }
  if (type === "support") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 13v-2a8 8 0 0 1 16 0v2M4 13H2v5h4v-5H4Zm16 0h2v5h-4v-5h2ZM20 18c0 2-2 3-5 3" />
      </svg>
    );
  }
  if (type === "chat") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
        <path d="M8 10h8M8 13h5" />
      </svg>
    );
  }
  if (type === "recording") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8 6 4-6 4V8Z" />
      </svg>
    );
  }
  if (type === "live") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m10 9 5 3-5 3V9Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function CourseCard({ course }) {
  const status = getCourseLaunchStatus(course);
  const detailsLink = course?._fallbackLink || `/courses/${course.id}`;
  const [thumbnailSrc, setThumbnailSrc] = useState(course?.thumbnail || "");
  const safeTitle = course?.title || "Untitled course";
  const safeDescription = course?.description || "Professional cybersecurity training program.";
  const features = normalizeFeatures(course?.course_card_features);
  const hasCourseAccess =
    Boolean(course?.is_enrolled) ||
    normalizeEnrollmentStatus(course?.enrollment_status) === "approved";

  useEffect(() => {
    setThumbnailSrc(course?.thumbnail || "");
  }, [course?.id, course?.thumbnail]);

  const primaryAction = (() => {
    if (status.isComingSoon) {
      return { label: "Coming Soon", disabled: true };
    }
    if (hasCourseAccess) {
      return { label: "Continue Course", to: `/learn/${course.id}` };
    }
    if (course?.purchase_available) {
      return { label: "Enroll Now", to: `/courses/${course.id}/payment` };
    }
    return { label: "Purchase Unavailable", disabled: true };
  })();

  return (
    <article className="group relative flex h-full min-w-0 flex-col overflow-hidden rounded-[26px] border border-white/15 bg-[#090909] text-white shadow-[0_28px_80px_rgba(0,0,0,0.48)] sm:rounded-[30px]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_92%_9%,rgba(255,255,255,0.075),transparent_31%)]" />
      {thumbnailSrc ? (
        <img
          src={thumbnailSrc}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="pointer-events-none absolute right-0 top-0 h-[36%] w-[58%] object-cover object-center opacity-[0.12] grayscale transition duration-500 group-hover:opacity-[0.17]"
          onError={() => {
            if (thumbnailSrc !== COURSE_FALLBACK_THUMBNAIL) {
              setThumbnailSrc(COURSE_FALLBACK_THUMBNAIL);
            } else {
              setThumbnailSrc("");
            }
          }}
        />
      ) : null}
      <div className="pointer-events-none absolute right-0 top-0 h-[40%] w-[70%] bg-gradient-to-l from-transparent via-[#090909]/35 to-[#090909]" />

      <div className="relative flex h-full flex-col px-5 pb-5 pt-7 sm:px-7 sm:pb-7 sm:pt-9">
        <div className="border-b border-white/10 pb-6 sm:pb-8">
          <div className="mb-5 flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#858585] sm:text-[11px]">
              Professional Training Program
            </span>
            <span className="rounded-full border border-white/15 bg-black/55 px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-[#C8C8C8]">
              {status.label}
            </span>
          </div>
          <Link to={detailsLink} className="block max-w-[92%]">
            <h3 className="font-reference text-[clamp(1.85rem,4vw,3rem)] font-semibold leading-[1.03] tracking-[-0.035em] text-white transition group-hover:text-[#F2F2F2]">
              {safeTitle}
            </h3>
          </Link>
          <p className="mt-4 max-w-[92%] text-sm leading-6 text-[#A4A4A4] sm:text-base sm:leading-7">
            {safeDescription}
          </p>
        </div>

        <div className="divide-y divide-white/10">
          {features.map((feature, index) => (
            <div
              key={`${feature.title}-${index}`}
              className="grid grid-cols-[48px_minmax(0,1fr)] gap-4 py-4 sm:grid-cols-[58px_minmax(0,1fr)] sm:gap-5 sm:py-5"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-[#202020] text-white sm:h-[58px] sm:w-[58px]">
                <span className="h-6 w-6 [&_svg]:h-full [&_svg]:w-full [&_svg]:fill-none [&_svg]:stroke-current [&_svg]:stroke-[1.8] [&_svg]:stroke-linecap-round [&_svg]:stroke-linejoin-round">
                  <FeatureIcon type={feature.icon} />
                </span>
              </span>
              <div className="min-w-0 border-l border-white/15 pl-4 sm:pl-5">
                <h4 className="text-[15px] font-semibold leading-5 text-[#F3F3F3] sm:text-base">
                  {feature.title}
                </h4>
                <p className="mt-1 text-[13px] leading-5 text-[#929292] sm:text-sm sm:leading-6">
                  {feature.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-auto pt-3">
          {primaryAction.to ? (
            <Link
              to={primaryAction.to}
              className="inline-flex min-h-[56px] w-full items-center justify-center gap-4 rounded-full border border-white bg-white px-5 text-sm font-bold uppercase tracking-[0.18em] text-black transition hover:bg-[#E7E7E7] focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-black"
            >
              {primaryAction.label}
              <span aria-hidden="true" className="text-2xl font-light leading-none">
                →
              </span>
            </Link>
          ) : (
            <span className="inline-flex min-h-[56px] w-full cursor-not-allowed items-center justify-center rounded-full border border-white/15 bg-[#222222] px-5 text-sm font-bold uppercase tracking-[0.14em] text-[#858585]">
              {primaryAction.label}
            </span>
          )}

          <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-[#808080]">
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-4 w-4 fill-none stroke-current stroke-[1.7]"
            >
              <path d="M12 3 5 6v5c0 4.6 2.8 8.4 7 10 4.2-1.6 7-5.4 7-10V6l-7-3Z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span>
              {hasCourseAccess
                ? "Protected learning access"
                : status.isComingSoon
                  ? "Program enrollment opening soon"
                  : "Secure Enrollment"}
            </span>
            <span aria-hidden="true">•</span>
            <Link to={detailsLink} className="transition hover:text-white">
              View Details
            </Link>
          </div>

          {!status.isComingSoon && !hasCourseAccess && !course?.purchase_available ? (
            <p className="mt-3 text-center text-xs leading-5 text-[#858585]">
              {getPurchaseUnavailableMessage(course)}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export default memo(CourseCard);
