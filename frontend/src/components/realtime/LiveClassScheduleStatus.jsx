import { Link } from "react-router-dom";
import { DEFAULT_LIVE_CLASS_SCHEDULE, formatNextLiveWindow } from "../../utils/liveClassSchedule";

export default function LiveClassScheduleStatus({ schedule, liveSession, compact = false }) {
  const currentSchedule = schedule || DEFAULT_LIVE_CLASS_SCHEDULE;

  if (liveSession) {
    return (
      <section className={`rounded-2xl border border-red-500/55 bg-red-950/25 ${compact ? "p-4" : "p-5 sm:p-6"}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-red-300">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_16px_rgba(239,68,68,0.85)]" />
              Live now
            </div>
            <h3 className={`${compact ? "mt-2 text-lg" : "mt-3 text-2xl sm:text-3xl"} font-reference font-semibold text-white`}>
              Your live class is in progress
            </h3>
            <p className="mt-2 text-sm leading-6 text-red-100/75">
              {liveSession.title || "Your approved live class"} is live. Join the classroom now.
            </p>
          </div>
          <Link
            to={`/join-live?session=${liveSession.id}`}
            className="inline-flex min-h-14 w-full items-center justify-center rounded-xl bg-red-600 px-8 py-4 text-base font-extrabold uppercase tracking-[0.1em] text-white shadow-[0_18px_38px_rgba(220,38,38,0.28)] transition hover:bg-red-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 sm:w-auto"
          >
            Join Live
            <span aria-hidden="true" className="ml-3">→</span>
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-2xl border border-white/10 bg-[#111111] ${compact ? "p-4" : "p-5 sm:p-6"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#929292]">
        Weekly live-class schedule
      </div>
      <h3 className={`${compact ? "mt-2 text-lg" : "mt-3 text-2xl"} font-reference font-semibold text-white`}>
        Friday, Saturday and Sunday
      </h3>
      <p className="mt-2 text-base font-semibold text-[#D7D7D7]">7:00 PM to 8:00 PM IST</p>
      <p className="mt-3 text-sm leading-6 text-[#929292]">
        No approved session is live right now. This screen will automatically show the live entry
        when your instructor starts an enrolled class during the scheduled hour.
      </p>
      <div className="mt-4 rounded-xl border border-white/8 bg-black/45 px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.15em] text-[#777777]">Next class window</div>
        <div className="mt-1 text-sm font-semibold text-[#D7D7D7]">{formatNextLiveWindow(currentSchedule)}</div>
      </div>
    </section>
  );
}
