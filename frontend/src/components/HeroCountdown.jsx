import { useEffect, useState } from "react";

import { selectActiveCourseCountdown } from "../utils/courseCountdown";

const TIMER_UNITS = [
  ["days", "Days"],
  ["hours", "Hours"],
  ["minutes", "Minutes"],
  ["seconds", "Seconds"],
];

export default function HeroCountdown({ courses = [] }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeCountdown = selectActiveCourseCountdown(courses, now);
  if (!activeCountdown) return null;

  const courseTitle = activeCountdown.course?.card_title || activeCountdown.course?.title;

  return (
    <aside
      className="mx-auto mb-8 grid max-w-6xl overflow-hidden rounded-2xl border border-red-400/35 bg-[linear-gradient(110deg,rgba(127,29,29,0.96),rgba(69,10,10,0.98))] shadow-[0_18px_54px_rgba(127,29,29,0.32)] lg:grid-cols-[minmax(0,1fr)_auto]"
      aria-label="Enrollment countdown"
    >
      <div className="flex min-w-0 items-center gap-4 border-b border-red-300/20 px-5 py-4 lg:border-b-0 lg:border-r lg:px-7">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-red-200/30 bg-red-950/60">
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-white stroke-[1.8]">
            <circle cx="12" cy="13" r="8" />
            <path d="M9 2h6M12 5v3M12 13l3-2" />
          </svg>
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-red-100">
            {activeCountdown.label}
          </p>
          {courseTitle ? (
            <p className="mt-1 truncate text-sm font-semibold text-white sm:text-base">{courseTitle}</p>
          ) : null}
        </div>
      </div>

      <time
        dateTime={activeCountdown.deadline}
        className="grid grid-cols-4 divide-x divide-red-200/20"
        role="timer"
        aria-live="off"
      >
        {TIMER_UNITS.map(([key, label]) => (
          <span key={key} className="flex min-w-[70px] flex-col items-center justify-center px-3 py-3 sm:min-w-[86px] sm:px-5">
            <strong className="font-reference text-2xl font-semibold tabular-nums text-white sm:text-3xl">
              {String(activeCountdown.parts[key]).padStart(2, "0")}
            </strong>
            <span className="mt-1 text-[8px] font-bold uppercase tracking-[0.18em] text-red-100/75 sm:text-[9px]">
              {label}
            </span>
          </span>
        ))}
      </time>
    </aside>
  );
}
