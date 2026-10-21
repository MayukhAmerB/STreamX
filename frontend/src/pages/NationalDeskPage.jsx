import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

const INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==";

const PAGES = [
  { key: "file-fir", label: "How to File an FIR" },
  { key: "laws", label: "Laws to Know" },
  { key: "tracker", label: "FIR Across India" },
];

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

function PlayIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  );
}

function ChevronRight({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ArrowRight({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function HeadphonesIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2ZM20 14a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2Z" />
    </svg>
  );
}

function ClockIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function BookIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h11a2 2 0 0 1 2 2v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v15" />
    </svg>
  );
}

function PersonIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

function ClipboardCheckIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1" />
      <path d="m9 13 2 2 4-4" />
    </svg>
  );
}

function ScaleIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18M7 21h10" />
      <path d="M12 6 4 8m8-2 8 2" />
      <path d="M4 8 1.5 14h5L4 8ZM20 8l-2.5 6h5L20 8Z" />
    </svg>
  );
}

function ShieldIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6l-7-3Z" />
    </svg>
  );
}

function MegaphoneIcon({ className = "h-6 w-6" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1Z" />
      <path d="M18 8a4 4 0 0 1 0 8" />
      <path d="M7 15v3a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

function InstagramIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function PinIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}

function ExternalIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

function CompassIcon({ className = "h-7 w-7" }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path d="M24 4v10M24 34v10M4 24h10M34 24h10" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M24 10 28 24 24 20 20 24 24 10Z" fill="rgba(255,255,255,0.85)" />
      <path d="M24 38 20 24 24 28 28 24 24 38Z" fill="rgba(255,255,255,0.3)" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function Kicker({ children }) {
  return (
    <span className="inline-flex items-center rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-[#B9B9B9]">
      {children}
    </span>
  );
}

function Waveform({ bars = 42, className = "" }) {
  const heights = useMemo(
    () => Array.from({ length: bars }, (_, i) => 20 + Math.round(Math.abs(Math.sin(i * 1.3) * 60) + (i % 5) * 6)),
    [bars],
  );
  return (
    <div className={`flex items-center gap-[3px] ${className}`} aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className="nd-wave-bar w-[2px] rounded-full bg-white/45"
          style={{ height: `${Math.min(h, 72)}%`, animationDelay: `${(i % 9) * 0.09}s` }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* View 1 — How to File an FIR                                         */
/* ------------------------------------------------------------------ */

function FileFirView() {
  return (
    <article className="nd-view overflow-hidden rounded-[26px] border border-white/10 bg-[#070707] shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
      {/* Hero */}
      <div className="relative h-[300px] overflow-hidden sm:h-[360px]">
        <div className="absolute inset-0 bg-[radial-gradient(130%_120%_at_30%_10%,#2b2b2b_0%,#141414_42%,#050505_100%)]" />
        <div className="absolute inset-0 opacity-[0.5] bg-[linear-gradient(115deg,transparent_0%,rgba(255,255,255,0.05)_38%,transparent_60%)]" />
        {/* police cap suggestion */}
        <div className="absolute right-6 top-6 h-20 w-28 rounded-[40%] bg-[radial-gradient(circle_at_50%_30%,#333_0%,#111_70%,#050505_100%)] opacity-70 blur-[1px] sm:h-24 sm:w-36" />
        {/* POLICE strip */}
        <div className="absolute left-5 top-8 -rotate-6 rounded bg-black/55 px-3 py-1 text-[13px] font-bold uppercase tracking-[0.3em] text-white/55">
          Police
        </div>

        {/* FIR paper */}
        <div className="absolute left-1/2 top-1/2 w-[260px] -translate-x-1/2 -translate-y-1/2 rotate-[-3deg] rounded-sm bg-gradient-to-b from-[#d8d6cf] to-[#b7b4aa] p-4 text-[#1b1b1b] shadow-[0_24px_60px_rgba(0,0,0,0.6)] sm:w-[320px] sm:p-5">
          <div className="text-center">
            <div className="mx-auto mb-1 h-6 w-6 rounded-full border border-[#1b1b1b]/60 sm:h-7 sm:w-7" />
            <div className="text-[7px] font-semibold tracking-[0.2em] text-[#1b1b1b]/70">सत्यमेव जयते</div>
            <div className="mt-1 text-xl font-black tracking-[0.12em] sm:text-2xl">FIR</div>
            <div className="text-[8px] font-bold uppercase tracking-[0.14em] sm:text-[9px]">First Information Report</div>
          </div>
          <div className="mt-3 space-y-[7px] text-[8px] font-medium text-[#1b1b1b]/80 sm:text-[9px]">
            {["Police Station :", "District :", "Date & Time of Registration :", "FIR No. :", "Acts / Sections :"].map((line) => (
              <div key={line} className="flex items-end gap-1">
                <span className="whitespace-nowrap">{line}</span>
                <span className="mb-[2px] h-px flex-1 bg-[#1b1b1b]/35" />
              </div>
            ))}
            <div className="mb-[2px] h-px w-full bg-[#1b1b1b]/35" />
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[#070707] to-transparent" />
        <div className="absolute left-5 bottom-5 sm:left-8">
          <span className="inline-flex items-center rounded-full border border-white/20 bg-black/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-white/80 backdrop-blur">
            Practical Guide
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="px-5 pb-7 pt-6 sm:px-9 sm:pb-10 sm:pt-8">
        <p className="text-[12px] font-semibold uppercase tracking-[0.32em] text-[#8c8c8c]">Section 01</p>
        <h2 className="mt-3 text-[2.4rem] font-black leading-[1.02] tracking-[-0.03em] text-white sm:text-[3.4rem]">
          How to File an FIR
        </h2>
        <p className="mt-4 max-w-xl text-[15px] leading-7 text-[#9a9a9a] sm:text-base">
          Step-by-step guide to filing an FIR, from the complaint letter to the final process.
        </p>

        {/* Audio guide */}
        <div className="mt-8 rounded-[20px] border border-white/10 bg-white/[0.03] p-5 sm:p-6">
          <div className="flex items-center gap-2 text-[#9a9a9a]">
            <HeadphonesIcon className="h-4 w-4" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.3em]">Audio Guide</span>
          </div>
          <h3 className="mt-3 text-lg font-bold text-white sm:text-xl">FIR Filing Process &ndash; Step by Step</h3>
          <div className="mt-2 flex items-center gap-2 text-sm text-[#9a9a9a]">
            <ClockIcon className="h-4 w-4" />
            <span>12:48</span>
          </div>
          <div className="mt-5 flex items-center gap-4">
            <button
              type="button"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/5 text-white transition hover:bg-white/15"
              aria-label="Play FIR filing audio guide"
            >
              <PlayIcon className="h-5 w-5 translate-x-[1px]" />
            </button>
            <Waveform className="h-9 flex-1" bars={46} />
            <button
              type="button"
              className="hidden shrink-0 items-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 sm:inline-flex"
            >
              <HeadphonesIcon className="h-4 w-4" />
              Listen Now
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* View 2 — Laws You Need to Know                                      */
/* ------------------------------------------------------------------ */

const LAW_ROWS = [
  {
    icon: BookIcon,
    title: "Your Right to File a Complaint",
    body: "Under Section 154 of the CrPC, you have the right to file an FIR. The police must register it without delay.",
    duration: "04:32",
  },
  {
    icon: PersonIcon,
    title: "What to Do If FIR Is Not Registered",
    body: "If the police refuse to register your complaint, you can approach higher authorities or a magistrate.",
    duration: "03:18",
  },
  {
    icon: ClipboardCheckIcon,
    title: "Your Rights During Police Interrogation",
    body: "You have the right to remain silent, to legal counsel, and to not be forced into self-incrimination.",
    duration: "05:26",
  },
  {
    icon: ScaleIcon,
    title: "Important Legal Provisions to Know",
    body: "Key sections: IPC (e.g., 499, 500), CrPC (e.g., 41, 41A, 161), and your fundamental rights under the Constitution.",
    duration: "06:14",
  },
  {
    icon: ShieldIcon,
    title: "What to Do After Filing the FIR",
    body: "Next steps; follow-up, investigation process, and how to track your case status.",
    duration: "04:50",
  },
];

function LawsView() {
  return (
    <article className="nd-view overflow-hidden rounded-[26px] border border-white/10 bg-[#070707] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.55)] sm:p-9">
      {/* Header */}
      <div className="relative grid gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
        <div>
          <Kicker>Section 05</Kicker>
          <h2 className="mt-5 text-[2.1rem] font-black leading-[1.04] tracking-[-0.03em] text-white sm:text-[3rem]">
            Laws You Need to Know Before Going to a Police Station
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-[#8f8f8f] sm:text-base">
            Know your rights. Be prepared. These key laws will help you understand your legal position and ensure you&rsquo;re not taken advantage of.
          </p>
        </div>
        {/* Books + gavel hero */}
        <div className="relative hidden h-full min-h-[230px] overflow-hidden rounded-2xl lg:block">
          <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_70%_20%,#2a2a2a_0%,#131313_50%,#070707_100%)]" />
          <div className="absolute right-6 top-6 space-y-2">
            {["Criminal Procedure Code", "Indian Penal Code", "Constitution of India"].map((book, i) => (
              <div
                key={book}
                className="flex h-10 items-center rounded-sm bg-gradient-to-r from-[#1b1b1b] to-[#2c2c2c] px-3 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/55 shadow-[0_8px_18px_rgba(0,0,0,0.5)]"
                style={{ width: `${220 - i * 16}px` }}
              >
                {book}
              </div>
            ))}
          </div>
          {/* gavel */}
          <div className="absolute bottom-6 right-10">
            <div className="h-5 w-16 -rotate-[18deg] rounded bg-gradient-to-r from-[#3a3a3a] to-[#161616] shadow-[0_8px_20px_rgba(0,0,0,0.6)]" />
            <div className="ml-2 mt-2 h-2 w-12 rounded-full bg-[#1b1b1b]" />
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className="mt-8 space-y-3">
        {LAW_ROWS.map(({ icon: Icon, title, body, duration }) => (
          <button
            key={title}
            type="button"
            className="group flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4 text-left transition hover:border-white/20 hover:bg-white/[0.05] sm:px-5"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/75 sm:h-14 sm:w-14">
              <Icon className="h-5 w-5 sm:h-6 sm:w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-white sm:text-base">{title}</span>
              <span className="mt-1 block text-[13px] leading-6 text-[#8f8f8f] sm:text-sm">{body}</span>
            </span>
            <span className="hidden shrink-0 items-center gap-3 sm:flex">
              <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-white/80 transition group-hover:bg-white/10">
                <PlayIcon className="h-4 w-4 translate-x-[1px]" />
              </span>
              <span className="text-right leading-tight text-[#9a9a9a]">
                <span className="block text-[13px]">Audio</span>
                <span className="block text-[13px]">{duration}</span>
              </span>
              <ChevronRight className="h-4 w-4 text-[#6e6e6e]" />
            </span>
            <span className="flex shrink-0 items-center gap-2 sm:hidden">
              <span className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white/80">
                <PlayIcon className="h-3.5 w-3.5 translate-x-[1px]" />
              </span>
              <ChevronRight className="h-4 w-4 text-[#6e6e6e]" />
            </span>
          </button>
        ))}
      </div>

      {/* Instagram CTA */}
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/75">
              <MegaphoneIcon className="h-6 w-6" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#8c8c8c]">Stay Updated</p>
              <p className="mt-1 text-[15px] font-bold text-white">Get the latest updates &amp; new guides</p>
              <p className="mt-1 max-w-md text-[13px] leading-6 text-[#8f8f8f]">
                Follow us on Instagram for more legal awareness content, real-time updates and important announcements.
              </p>
            </div>
          </div>
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            <InstagramIcon className="h-5 w-5" />
            Follow on Instagram
            <ChevronRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* View 3 — FIR Process Across India                                   */
/* ------------------------------------------------------------------ */

const STATS = [
  { label: "Total FIRs Filed", value: "37", note: "(So Far)", kind: "completed" },
  { label: "In Progress", value: "18", note: "(Locations)", kind: "progress" },
  { label: "Completed", value: "12", note: "(Locations)", kind: "done" },
  { label: "Planned / Upcoming", value: "7", note: "(Locations)", kind: "planned" },
];

const UPDATES = [
  { city: "Lucknow, Uttar Pradesh", state: "FIR Registered", status: "Completed", date: "18 Oct 2025" },
  { city: "Bhopal, Madhya Pradesh", state: "Under Process", status: "In Progress", date: "17 Oct 2025" },
  { city: "Hyderabad, Telangana", state: "FIR Registered", status: "Completed", date: "16 Oct 2025" },
  { city: "Jaipur, Rajasthan", state: "Under Process", status: "In Progress", date: "15 Oct 2025" },
  { city: "Kolkata, West Bengal", state: "FIR Registered", status: "Completed", date: "14 Oct 2025" },
];

// Approximate dot positions on the India map (percentages within the map box).
const MAP_DOTS = [
  { x: 36, y: 20, s: 1 }, { x: 30, y: 28, s: 0.7 }, { x: 44, y: 24, s: 0.8 },
  { x: 25, y: 38, s: 0.9 }, { x: 38, y: 40, s: 1.1 }, { x: 52, y: 36, s: 0.7 },
  { x: 62, y: 42, s: 0.8 }, { x: 70, y: 40, s: 0.7 }, { x: 46, y: 50, s: 0.9 },
  { x: 33, y: 55, s: 0.8 }, { x: 58, y: 54, s: 1 }, { x: 42, y: 62, s: 0.9 },
  { x: 50, y: 68, s: 0.8 }, { x: 36, y: 72, s: 1 }, { x: 44, y: 82, s: 0.9 },
  { x: 40, y: 90, s: 0.7 },
];

function IndiaMap() {
  return (
    <div className="relative aspect-[4/5] w-full overflow-hidden rounded-2xl border border-white/10 bg-[#050505] p-3">
      <div className="absolute inset-0 opacity-[0.35] [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:26px_26px]" />
      <div className="absolute left-3 top-3 flex flex-col items-center text-white/50">
        <CompassIcon className="h-7 w-7" />
      </div>
      <svg viewBox="0 0 400 480" className="relative h-full w-full" aria-hidden="true">
        <path
          d="M150 28 C135 40 128 54 120 62 C104 70 92 72 78 82 C70 96 66 118 58 142 C52 160 48 172 52 182 C60 186 72 182 78 190 C82 206 76 224 84 248 C96 276 112 302 128 332 C140 356 150 386 162 414 C168 432 174 448 178 452 C184 446 190 420 198 392 C208 360 220 330 236 300 C252 270 266 240 278 210 C288 186 296 168 300 150 C312 148 326 150 338 140 C352 128 362 120 356 110 C344 112 330 122 318 120 C300 116 286 96 268 86 C248 74 224 62 204 50 C186 40 166 30 150 28 Z"
          fill="rgba(255,255,255,0.045)"
          stroke="rgba(255,255,255,0.4)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        {/* a few internal state strokes for texture */}
        <path
          d="M120 110 C160 120 210 118 250 130 M110 170 C160 180 210 185 260 180 M130 240 C170 250 210 255 250 250 M150 320 C180 320 210 315 235 300"
          fill="none"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="1"
        />
      </svg>
      {MAP_DOTS.map((d, i) => (
        <span
          key={i}
          className="nd-dot-glow absolute rounded-full bg-white shadow-[0_0_12px_4px_rgba(255,255,255,0.5)]"
          style={{
            left: `${d.x}%`,
            top: `${d.y}%`,
            width: `${6 * d.s}px`,
            height: `${6 * d.s}px`,
            animationDelay: `${(i % 7) * 0.3}s`,
          }}
        />
      ))}
    </div>
  );
}

function StatMarker({ kind }) {
  if (kind === "completed") {
    return (
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    );
  }
  if (kind === "progress") {
    return (
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" fill="none">
          <circle cx="12" cy="12" r="8" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
          <circle cx="12" cy="12" r="8" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="34 50" />
        </svg>
      </span>
    );
  }
  if (kind === "done") {
    return (
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <span className="h-5 w-5 rounded-full bg-white/80" />
      </span>
    );
  }
  return (
    <span className="flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
      <span className="h-5 w-5 rounded-full border-2 border-white/40" />
    </span>
  );
}

function statusDotClass(status) {
  if (status === "Completed") return "bg-white";
  if (status === "In Progress") return "border-2 border-white/50";
  return "border-2 border-white/30";
}

function TrackerView() {
  return (
    <article className="nd-view overflow-hidden rounded-[26px] border border-white/10 bg-[#070707] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.55)] sm:p-9">
      {/* Header */}
      <div className="relative grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-start">
        <div>
          <Kicker>National Progress</Kicker>
          <h2 className="mt-5 text-[2.2rem] font-black leading-[1.02] tracking-[-0.03em] text-white sm:text-[3rem]">
            FIR Process<br className="hidden sm:block" /> Across India
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-7 text-[#8f8f8f] sm:text-base">
            We are tracking FIRs filed across the country. Here you can see where the process is active, which locations have already registered FIRs, and where it is still in progress.
          </p>
        </div>
        <div className="relative hidden min-h-[180px] overflow-hidden rounded-2xl lg:block">
          <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_70%_10%,#2a2a2a_0%,#121212_52%,#070707_100%)]" />
          {/* dome suggestion */}
          <div className="absolute right-10 top-7 h-16 w-28 rounded-t-full bg-[radial-gradient(circle_at_50%_80%,#3a3a3a,#141414)] opacity-80" />
          <div className="absolute right-6 top-[5.5rem] h-16 w-36 bg-gradient-to-t from-[#1b1b1b] to-[#2a2a2a] opacity-70" />
          <p className="absolute bottom-6 right-6 text-right text-[11px] font-semibold uppercase leading-5 tracking-[0.22em] text-white/45">
            More FIRs. Stronger Voices.<br />Across India.
          </p>
        </div>
      </div>

      {/* Map + stats */}
      <div className="mt-8 grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <IndiaMap />
        <div className="flex flex-col gap-3">
          {STATS.map((s) => (
            <div key={s.label} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4">
              <StatMarker kind={s.kind} />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8c8c8c]">{s.label}</p>
                <p className="mt-1 text-2xl font-black text-white sm:text-3xl">
                  {s.value} <span className="text-sm font-medium text-[#8f8f8f]">{s.note}</span>
                </p>
              </div>
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-4 px-1 text-[13px] text-[#9a9a9a]">
            <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-white" /> Completed</span>
            <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border border-white/50" /> In Progress</span>
            <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border border-white/30" /> Planned</span>
          </div>
        </div>
      </div>

      {/* Latest updates */}
      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white">
            <PinIcon className="h-5 w-5" />
            <span className="text-[13px] font-semibold uppercase tracking-[0.24em]">Latest Updates</span>
          </div>
          <button type="button" className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-white/10">
            View All <ArrowRight className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 divide-y divide-white/[0.06]">
          {UPDATES.map((u) => (
            <div key={u.city} className="flex items-center justify-between gap-3 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold uppercase tracking-[0.04em] text-white">{u.city}</p>
                <p className="text-[12px] text-[#8f8f8f]">{u.state}</p>
              </div>
              <div className="flex shrink-0 items-center gap-4">
                <span className="hidden items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#cfcfcf] sm:inline-flex">
                  <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(u.status)}`} />
                  {u.status}
                </span>
                <span className="w-[72px] text-right text-[12px] text-[#9a9a9a]">{u.date}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Full tracker CTA */}
      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/75">
              <PinIcon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-white">See the Full List &amp; Real-Time Progress</p>
              <p className="mt-1 max-w-md text-[13px] leading-6 text-[#8f8f8f]">
                View complete state-wise updates, detailed status, and new FIRs as they are added.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            <ExternalIcon className="h-5 w-5" />
            View Full Tracker
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Page shell with tab navigation                                      */
/* ------------------------------------------------------------------ */

export default function NationalDeskPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const initial = useMemo(() => {
    const view = new URLSearchParams(location.search).get("view");
    return PAGES.some((p) => p.key === view) ? view : PAGES[0].key;
  }, [location.search]);

  const [active, setActive] = useState(initial);
  const topRef = useRef(null);

  useEffect(() => {
    setActive(initial);
  }, [initial]);

  const activeIndex = PAGES.findIndex((p) => p.key === active);

  const goTo = (key) => {
    setActive(key);
    navigate(`/national-desk?view=${key}`, { replace: true });
    if (topRef.current) {
      topRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const goRelative = (delta) => {
    const next = (activeIndex + delta + PAGES.length) % PAGES.length;
    goTo(PAGES[next].key);
  };

  return (
    <section ref={topRef} className="mx-auto max-w-5xl px-3 py-6 text-white sm:px-5 sm:py-10 lg:px-6">
      {/* Heading */}
      <div className="mb-6">
        <div className="mb-3 h-1 w-10 rounded-full bg-white/70" aria-hidden="true" />
        <h1 className="text-[1.9rem] font-black tracking-[-0.03em] text-white sm:text-[2.4rem]">National Desk</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#949494] sm:text-base">
          FIR guidance, your legal rights, and live national tracking &mdash; all in one place.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="mb-6 flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-white/[0.02] p-1.5">
        {PAGES.map((p, i) => {
          const isActive = p.key === active;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => goTo(p.key)}
              aria-current={isActive ? "page" : undefined}
              className={`flex-1 whitespace-nowrap rounded-xl px-3 py-2.5 text-[13px] font-semibold transition sm:text-sm ${
                isActive
                  ? "bg-white text-black shadow-[0_6px_18px_rgba(255,255,255,0.12)]"
                  : "text-[#b9b9b9] hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <span className="mr-1.5 text-[11px] opacity-60">0{i + 1}</span>
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Active view */}
      <div key={active}>
        {active === "file-fir" ? <FileFirView /> : null}
        {active === "laws" ? <LawsView /> : null}
        {active === "tracker" ? <TrackerView /> : null}
      </div>

      {/* Prev / Next movement */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => goRelative(-1)}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
        >
          <ChevronRight className="h-4 w-4 rotate-180" />
          <span className="hidden sm:inline">{PAGES[(activeIndex - 1 + PAGES.length) % PAGES.length].label}</span>
          <span className="sm:hidden">Prev</span>
        </button>
        <div className="flex items-center gap-2">
          {PAGES.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-label={`Go to ${p.label}`}
              onClick={() => goTo(p.key)}
              className={`h-2 rounded-full transition-all ${p.key === active ? "w-6 bg-white" : "w-2 bg-white/25 hover:bg-white/50"}`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => goRelative(1)}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10"
        >
          <span className="hidden sm:inline">{PAGES[(activeIndex + 1) % PAGES.length].label}</span>
          <span className="sm:hidden">Next</span>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </section>
  );
}
