import { useRef } from "react";

import CourseCard from "./CourseCard";

export const COURSE_RAIL_DESKTOP_VISIBLE = 4;

export default function CourseCardRail({ courses = [] }) {
  const railRef = useRef(null);
  const normalizedCourses = Array.isArray(courses) ? courses : [];
  const canScroll = normalizedCourses.length > 1;

  const scrollRail = (direction) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({
      left: direction * Math.max(rail.clientWidth * 0.9, 280),
      behavior: "smooth",
    });
  };

  return (
    <div className="mt-6">
      <div className="mb-3 flex min-h-10 items-center justify-between gap-4">
        <p className="course-rail-note text-[10px] font-semibold uppercase tracking-[0.15em] text-[#858E94]">
          Oldest programs first
        </p>
        {canScroll ? (
          <div className="flex items-center gap-2" aria-label="Course carousel controls">
            <button
              type="button"
              className="course-rail-control inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/[0.04] text-white transition hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Scroll courses backward"
              onClick={() => scrollRail(-1)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
                <path d="m12.5 4.5-5.5 5.5 5.5 5.5" />
              </svg>
            </button>
            <button
              type="button"
              className="course-rail-control inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/20 bg-white/[0.04] text-white transition hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="Scroll courses forward"
              onClick={() => scrollRail(1)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 fill-none stroke-current stroke-2">
                <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />
              </svg>
            </button>
          </div>
        ) : null}
      </div>

      <div
        ref={railRef}
        className="course-card-rail grid snap-x snap-mandatory grid-flow-col auto-cols-[100%] gap-3 overflow-x-auto overscroll-x-contain pb-4 sm:auto-cols-[calc((100%_-_0.75rem)/2)] lg:auto-cols-[calc((100%_-_2.25rem)/4)]"
        aria-label="Courses in first-in, first-out order"
        data-desktop-visible={COURSE_RAIL_DESKTOP_VISIBLE}
      >
        {normalizedCourses.map((course) => (
          <div key={course.id} className="min-w-0 snap-start">
            <CourseCard course={course} />
          </div>
        ))}
      </div>
    </div>
  );
}
