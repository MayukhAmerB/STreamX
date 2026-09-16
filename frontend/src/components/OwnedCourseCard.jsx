import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  resolveCourseArtwork,
  resolveCourseArtworkFallback,
} from "../utils/courseArtwork";

function formatCategory(category) {
  return category === "web_pentesting" ? "Web & API Pentesting" : "OSINT";
}

function formatLevel(level) {
  const value = String(level || "").trim();
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "All levels";
}

function formatAccessDate(value) {
  if (!value) return "Recently added";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Recently added";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function normalizeProgress(course) {
  const lectureCount = Math.max(0, Number(course?.lecture_count || 0));
  const completedCount = Math.min(
    lectureCount,
    Math.max(0, Number(course?.completed_lecture_count || 0)),
  );
  const startedCount = Math.min(
    lectureCount,
    Math.max(completedCount, Number(course?.started_lecture_count || 0)),
  );
  const suppliedPercent = Number(course?.progress_percent);
  const progressPercent = Number.isFinite(suppliedPercent)
    ? Math.min(100, Math.max(0, Math.round(suppliedPercent)))
    : lectureCount > 0
      ? Math.round((completedCount / lectureCount) * 100)
      : 0;

  return { lectureCount, completedCount, startedCount, progressPercent };
}

export default function OwnedCourseCard({ course }) {
  const courseId = Number(course?.id || 0);
  const courseCategory = course?.category;
  const courseThumbnail = course?.thumbnail;
  const fallbackArtwork = resolveCourseArtworkFallback(courseCategory);
  const [artwork, setArtwork] = useState(() => resolveCourseArtwork(course));
  const { lectureCount, completedCount, startedCount, progressPercent } = normalizeProgress(course);
  const featureTitles = Array.isArray(course?.course_card_features)
    ? course.course_card_features
        .map((feature) => String(feature?.title || "").trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const facts = [
    course?.batch ? ["Batch", course.batch] : null,
    course?.duration ? ["Duration", course.duration] : null,
    course?.schedule ? ["Schedule", course.schedule] : null,
    Number(course?.total_classes || 0) > 0
      ? ["Live training", `${course.total_classes} classes`]
      : null,
  ].filter(Boolean);
  const progressLabel = lectureCount === 0
    ? "Curriculum is being prepared"
    : progressPercent >= 100
      ? "Course completed"
      : startedCount > 0
        ? `${completedCount} of ${lectureCount} lessons completed`
        : `${lectureCount} lessons ready to begin`;

  useEffect(() => {
    setArtwork(resolveCourseArtwork({ category: courseCategory, thumbnail: courseThumbnail }));
  }, [courseCategory, courseId, courseThumbnail]);

  return (
    <article className="student-library-card group grid overflow-hidden rounded-[22px] border border-white/15 bg-[#0A0B0D] shadow-[0_18px_50px_rgba(0,0,0,0.3)] md:grid-cols-[230px_minmax(0,1fr)]">
      <div className="relative min-h-[210px] overflow-hidden border-b border-white/10 bg-[#111417] md:min-h-full md:border-b-0 md:border-r">
        {artwork ? (
          <img
            src={artwork}
            alt={course?.image_alt || `${course?.title || "Course"} artwork`}
            className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.025]"
            loading="lazy"
            decoding="async"
            onError={() => {
              if (fallbackArtwork && artwork !== fallbackArtwork) setArtwork(fallbackArtwork);
              else setArtwork("");
            }}
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/30 to-black/10" />
        <div className="absolute inset-x-4 top-4 flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/25 bg-black/75 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-md">
            {formatCategory(course?.category)}
          </span>
          <span className="rounded-full border border-emerald-300/30 bg-emerald-950/75 px-2.5 py-1 text-[8px] font-bold uppercase tracking-[0.14em] text-emerald-200 backdrop-blur-md">
            {course?.access_label || "Active access"}
          </span>
        </div>
        <div className="absolute inset-x-4 bottom-4">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-white/65">Learning access</p>
          <p className="mt-1 text-xs font-semibold text-white">Added {formatAccessDate(course?.enrolled_at)}</p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.13em]">
          <span className="student-library-chip rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-[#D5D9DD]">
            {formatLevel(course?.level)}
          </span>
          <span className="student-library-chip rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-[#D5D9DD]">
            {course?.section_count || 0} modules
          </span>
          <span className="student-library-chip rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-[#D5D9DD]">
            {lectureCount} lessons
          </span>
        </div>

        <h2 className="student-library-title mt-3 font-reference text-xl font-semibold leading-tight tracking-[-0.025em] text-white sm:text-2xl">
          {course?.title || "Your course"}
        </h2>
        <p className="student-library-description mt-2 line-clamp-2 text-xs leading-5 text-[#AAB1B7] sm:text-sm sm:leading-6">
          {course?.card_summary || course?.description || "Your course curriculum is ready to explore."}
        </p>

        <div className="student-library-progress mt-4 rounded-xl border border-white/10 bg-black/30 px-3.5 py-3">
          <div className="flex items-center justify-between gap-3 text-[10px] font-semibold uppercase tracking-[0.11em]">
            <span className="student-library-muted text-[#AAB1B7]">{progressLabel}</span>
            <span className="student-library-progress-value text-white">{progressPercent}%</span>
          </div>
          <div
            className="student-library-progress-track mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-label={`${course?.title || "Course"} completion`}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={progressPercent}
          >
            <div
              className="h-full rounded-full bg-white transition-[width] duration-500"
              style={{ width: `${progressPercent}%` }}
              aria-hidden="true"
            />
          </div>
        </div>

        {facts.length ? (
          <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label} className="student-library-fact rounded-xl border border-white/10 bg-white/[0.035] px-3 py-2.5">
                <dt className="student-library-muted text-[8px] font-bold uppercase tracking-[0.13em] text-[#899198]">{label}</dt>
                <dd className="student-library-fact-value mt-1 line-clamp-2 text-[10px] font-semibold leading-4 text-[#E5E8EA]">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {featureTitles.length ? (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {featureTitles.map((feature) => (
              <li key={feature} className="student-library-feature flex items-center gap-1.5 text-[10px] text-[#B8BEC3]">
                <span className="h-1 w-1 rounded-full bg-white" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-auto flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="student-library-muted min-w-0 text-[10px] text-[#929AA0]">
            Instructor: <span className="student-library-instructor font-semibold text-[#DDE1E4]">{course?.instructor?.full_name || "Course faculty"}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/learn/${courseId}`}
              className="student-library-primary inline-flex min-h-9 items-center justify-center rounded-md bg-white px-3 text-[9px] font-bold uppercase tracking-[0.09em] text-black transition hover:bg-[#E5E5E5]"
            >
              {startedCount > 0 ? "Continue" : "Start learning"}
            </Link>
            <Link
              to={`/courses/${courseId}/live`}
              className="student-library-secondary inline-flex min-h-9 items-center justify-center rounded-md border border-white/20 px-3 text-[9px] font-bold uppercase tracking-[0.09em] text-white transition hover:border-white/45 hover:bg-white/[0.06]"
            >
              Live classes
            </Link>
            <Link
              to={`/courses/${courseId}`}
              className="student-library-secondary inline-flex min-h-9 items-center justify-center rounded-md border border-white/20 px-3 text-[9px] font-bold uppercase tracking-[0.09em] text-white transition hover:border-white/45 hover:bg-white/[0.06]"
            >
              Details
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
}
