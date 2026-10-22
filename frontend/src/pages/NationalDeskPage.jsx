import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import IndiaMap from "../components/IndiaMap";
import { SupremeCourtHero } from "../components/NationalDeskArt";
import { getNationalDesk } from "../api/nationalDesk";
import { apiData } from "../utils/api";
import heroFir from "../assets/nd-hero-fir.jpg";
import heroLaws from "../assets/nd-hero-laws.jpg";

const DEFAULT_INSTAGRAM_URL = "https://www.instagram.com/adlfrontofficial?igsh=MTgwN3Z2ZXZ4aGswYg==";

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

function PauseIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
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

function PinFilledIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M12 21.5s7-6.6 7-11.5a7 7 0 1 0-14 0c0 4.9 7 11.5 7 11.5Z" />
      <circle cx="12" cy="10" r="2.5" fill="#070707" />
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

function PdfIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
      <path d="M14 3v5h5" />
      <text x="12" y="17" textAnchor="middle" fontSize="5.5" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
    </svg>
  );
}

function VideoIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
      <path d="M8.5 10.5v3l2.5-1.5-2.5-1.5Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DownloadIcon({ className = "h-4 w-4" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

function ArrowLeftIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

const LAW_ICONS = {
  book: BookIcon,
  person: PersonIcon,
  clipboard: ClipboardCheckIcon,
  scale: ScaleIcon,
  shield: ShieldIcon,
  pdf: PdfIcon,
  video: VideoIcon,
};

// Thin, seekable progress bar used by the compact listen-guide player.
function LinearSeek({ progress = 0, onSeek, className = "" }) {
  const ref = useRef(null);
  const [dragging, setDragging] = useState(false);
  const seekFromClientX = (clientX) => {
    const el = ref.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={onSeek ? 0 : -1}
      aria-label="Seek audio"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className={`relative flex touch-none select-none items-center ${onSeek ? "cursor-pointer" : ""} ${className}`}
      onPointerDown={(e) => {
        if (!onSeek) return;
        setDragging(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        seekFromClientX(e.clientX);
      }}
      onPointerMove={(e) => { if (dragging) seekFromClientX(e.clientX); }}
      onPointerUp={(e) => {
        setDragging(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
    >
      <span className="h-1 w-full rounded-full bg-white/20">
        <span className="block h-full rounded-full bg-white" style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
      </span>
      <span
        className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
        style={{ left: `${Math.min(100, Math.max(0, progress * 100))}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Defaults (used until the admin-managed API responds)                */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  instagram: { enabled: true, url: DEFAULT_INSTAGRAM_URL },
  file_fir: {
    badge_label: "Practical Guide",
    section_label: "Section 01",
    title: "How to File an FIR",
    subtitle: "Step-by-step guide to filing an FIR, from the complaint letter to the final process.",
    hero_image_url: "",
    audio_kicker: "Audio Guide",
    audio_title: "FIR Filing Process – Step by Step",
    audio_duration: "12:48",
    audio_url: "",
  },
  laws: {
    section_label: "Section 05",
    title: "Laws You Need to Know Before Going to a Police Station",
    subtitle:
      "Know your rights. Be prepared. These key laws will help you understand your legal position and ensure you’re not taken advantage of.",
    hero_image_url: "",
    cta_kicker: "Stay Updated",
    cta_title: "Get the latest updates & new guides",
    cta_body:
      "Follow us on Instagram for more legal awareness content, real-time updates and important announcements.",
    topics: [
      { action_type: "audio", icon_key: "book", title: "Your Right to File a Complaint", body: "Under Section 154 of the CrPC, you have the right to file an FIR. The police must register it without delay.", audio_duration: "04:32", audio_url: "", pdf_url: "", videos: [] },
      { action_type: "audio", icon_key: "person", title: "What to Do If FIR Is Not Registered", body: "If the police refuse to register your complaint, you can approach higher authorities or a magistrate.", audio_duration: "03:18", audio_url: "", pdf_url: "", videos: [] },
      { action_type: "audio", icon_key: "clipboard", title: "Your Rights During Police Interrogation", body: "You have the right to remain silent, to legal counsel, and to not be forced into self-incrimination.", audio_duration: "05:26", audio_url: "", pdf_url: "", videos: [] },
      { action_type: "audio", icon_key: "scale", title: "Important Legal Provisions to Know", body: "Key sections: IPC (e.g., 499, 500), CrPC (e.g., 41, 41A, 161), and your fundamental rights under the Constitution.", audio_duration: "06:14", audio_url: "", pdf_url: "", videos: [] },
      { action_type: "audio", icon_key: "shield", title: "What to Do After Filing the FIR", body: "Next steps; follow-up, investigation process, and how to track your case status.", audio_duration: "04:50", audio_url: "", pdf_url: "", videos: [] },
      { action_type: "pdf", icon_key: "pdf", title: "Complaint Letter Format", body: "Download the ready-to-use complaint letter format to file your FIR.", audio_duration: "02:40", audio_url: "", pdf_url: "", videos: [] },
      {
        action_type: "video", icon_key: "video", title: "Video Proof Examples",
        body: "Watch sample video formats and how to present evidence properly.",
        audio_duration: "2:18", audio_url: "", pdf_url: "", view_all_url: "",
        audio_note: "Tap to listen to a quick guide on how to record and present evidence correctly.",
        videos: [
          { title: "Recording an Incident", description: "How to properly record a video at the scene and what details to include.", duration: "2:14", video_url: "", thumbnail_url: "" },
          { title: "Showing Location Proof", description: "How to capture location, surroundings and time in your video.", duration: "1:48", video_url: "", thumbnail_url: "" },
          { title: "Capturing Evidence (Do's & Don'ts)", description: "What to record, what to avoid, and common mistakes to prevent.", duration: "3:22", video_url: "", thumbnail_url: "" },
          { title: "How to Present Video to Police", description: "Step-by-step guide on how to submit your video evidence properly.", duration: "2:37", video_url: "", thumbnail_url: "" },
        ],
      },
    ],
  },
  tracker: {
    section_label: "National Progress",
    title: "FIR Process Across India",
    subtitle:
      "We are tracking FIRs filed across the country. Here you can see where the process is active, which locations have already registered FIRs, and where it is still in progress.",
    tagline: "More FIRs. Stronger Voices. Across India.",
    hero_image_url: "",
    stats: { total_filed: 37, in_progress: 18, completed: 12, planned: 7 },
    updates_cta_kicker: "See the Full List & Real-Time Progress",
    updates_cta_body: "View complete state-wise updates, detailed status, and new FIRs as they are added.",
    full_tracker_url: "",
    updates: [
      { city: "Lucknow", region: "Uttar Pradesh", status_note: "FIR Registered", status_display: "Completed", date: "18 Oct 2025" },
      { city: "Bhopal", region: "Madhya Pradesh", status_note: "Under Process", status_display: "In Progress", date: "17 Oct 2025" },
      { city: "Hyderabad", region: "Telangana", status_note: "FIR Registered", status_display: "Completed", date: "16 Oct 2025" },
      { city: "Jaipur", region: "Rajasthan", status_note: "Under Process", status_display: "In Progress", date: "15 Oct 2025" },
      { city: "Kolkata", region: "West Bengal", status_note: "FIR Registered", status_display: "Completed", date: "14 Oct 2025" },
    ],
  },
};

function mergeContent(apiPayload) {
  if (!apiPayload || typeof apiPayload !== "object") return DEFAULTS;
  const pick = (section) => ({ ...DEFAULTS[section], ...(apiPayload[section] || {}) });
  const laws = pick("laws");
  if (!Array.isArray(laws.topics) || laws.topics.length === 0) laws.topics = DEFAULTS.laws.topics;
  const tracker = pick("tracker");
  tracker.stats = { ...DEFAULTS.tracker.stats, ...(apiPayload.tracker?.stats || {}) };
  if (!Array.isArray(tracker.updates) || tracker.updates.length === 0) tracker.updates = DEFAULTS.tracker.updates;
  return {
    instagram: { ...DEFAULTS.instagram, ...(apiPayload.instagram || {}) },
    file_fir: pick("file_fir"),
    laws,
    tracker,
  };
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function Kicker({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center rounded-full border border-white/15 bg-white/[0.04] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-[#B9B9B9] ${className}`}>
      {children}
    </span>
  );
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Waveform that doubles as a seek bar: click or drag anywhere to jump.
function WaveformSeek({ progress = 0, onSeek, bars = 48, className = "" }) {
  const ref = useRef(null);
  const [dragging, setDragging] = useState(false);
  const heights = useMemo(
    () => Array.from({ length: bars }, (_, i) => 24 + Math.round(Math.abs(Math.sin(i * 1.3) * 54) + (i % 5) * 6)),
    [bars],
  );

  const seekFromClientX = (clientX) => {
    const el = ref.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={onSeek ? 0 : -1}
      aria-label="Seek audio"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      className={`relative flex touch-none select-none items-center gap-[2px] ${onSeek ? "cursor-pointer" : ""} ${className}`}
      onPointerDown={(e) => {
        if (!onSeek) return;
        setDragging(true);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        seekFromClientX(e.clientX);
      }}
      onPointerMove={(e) => { if (dragging) seekFromClientX(e.clientX); }}
      onPointerUp={(e) => {
        setDragging(false);
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }}
      onKeyDown={(e) => {
        if (!onSeek) return;
        if (e.key === "ArrowRight") { e.preventDefault(); onSeek(Math.min(1, progress + 0.05)); }
        if (e.key === "ArrowLeft") { e.preventDefault(); onSeek(Math.max(0, progress - 0.05)); }
      }}
    >
      {heights.map((h, i) => {
        const played = (i + 0.5) / bars <= progress;
        return (
          <span
            key={i}
            className={`flex-1 rounded-full transition-colors ${played ? "bg-white" : "bg-white/25"}`}
            style={{ height: `${Math.min(h, 72)}%` }}
          />
        );
      })}
    </div>
  );
}

function useAudioPlayer() {
  const audioRef = useRef(null);
  const [url, setUrl] = useState("");
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const getAudio = () => {
    if (!audioRef.current) {
      const audio = new Audio();
      audio.preload = "metadata";
      audio.addEventListener("timeupdate", () => setCurrentTime(audio.currentTime || 0));
      const syncDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.addEventListener("loadedmetadata", syncDuration);
      audio.addEventListener("durationchange", syncDuration);
      audio.addEventListener("play", () => setPlaying(true));
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("ended", () => { setPlaying(false); setCurrentTime(0); });
      audio.addEventListener("error", () => setPlaying(false));
      audioRef.current = audio;
    }
    return audioRef.current;
  };

  useEffect(
    () => () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
    },
    [],
  );

  // Point the shared element at a url (swapping source resets position).
  const load = (nextUrl) => {
    const audio = getAudio();
    if (url !== nextUrl) {
      audio.pause();
      audio.src = nextUrl;
      setUrl(nextUrl);
      setCurrentTime(0);
      setDuration(0);
    }
    return audio;
  };

  const toggle = (nextUrl) => {
    if (!nextUrl) return;
    const audio = load(nextUrl);
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  const seekFraction = (nextUrl, fraction) => {
    if (!nextUrl) return;
    const audio = load(nextUrl);
    const clamped = Math.min(1, Math.max(0, fraction));
    const applySeek = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = clamped * audio.duration;
        setCurrentTime(audio.currentTime);
      }
    };
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      applySeek();
    } else {
      const onMeta = () => {
        applySeek();
        audio.removeEventListener("loadedmetadata", onMeta);
      };
      audio.addEventListener("loadedmetadata", onMeta);
    }
    if (audio.paused) audio.play().catch(() => {});
  };

  return { url, playing, currentTime, duration, toggle, seekFraction };
}

/* ------------------------------------------------------------------ */
/* View 1 — How to File an FIR                                         */
/* ------------------------------------------------------------------ */

function FileFirView({ data, audio }) {
  const hasAudio = Boolean(data.audio_url);
  const active = hasAudio && audio.url === data.audio_url;
  const isPlaying = active && audio.playing;
  const cur = active ? audio.currentTime : 0;
  const dur = active ? audio.duration : 0;
  const progress = active && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  return (
    <article className="nd-view overflow-hidden rounded-[28px] border border-white/10 bg-[#070707] shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
      {/* Hero */}
      <div className="relative">
        <img
          src={data.hero_image_url || heroFir}
          alt="FIR (First Information Report) form on a desk with a police cap and pen"
          className="block w-full"
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[#070707] to-transparent" />
      </div>

      {/* Body */}
      <div className="px-5 pb-8 pt-6 sm:px-10 sm:pb-11 sm:pt-8">
        <h2 className="text-[2.6rem] font-black leading-[0.98] tracking-[-0.035em] text-white sm:text-[3.8rem]">
          {data.title}
        </h2>
        <p className="mt-5 max-w-xl text-[15px] leading-7 text-[#9a9a9a] sm:text-lg sm:leading-8">{data.subtitle}</p>

        {/* Audio guide */}
        <div className="mt-8 rounded-[22px] border border-white/10 bg-white/[0.03] p-5 sm:p-7">
          <div className="flex items-center gap-2 text-[#9a9a9a]">
            <HeadphonesIcon className="h-4 w-4" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.3em]">{data.audio_kicker}</span>
          </div>
          <h3 className="mt-3 text-xl font-bold text-white sm:text-2xl">{data.audio_title}</h3>
          <div className="mt-2 flex items-center gap-2 text-sm text-[#9a9a9a]">
            <ClockIcon className="h-4 w-4" />
            <span>{dur ? formatTime(dur) : data.audio_duration}</span>
          </div>
          <div className="mt-6 flex items-center gap-3 sm:gap-4">
            <button
              type="button"
              onClick={() => audio.toggle(data.audio_url)}
              disabled={!hasAudio}
              className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/5 text-white transition hover:bg-white/15 ${hasAudio ? "" : "opacity-50"}`}
              aria-label={isPlaying ? "Pause audio guide" : "Play FIR filing audio guide"}
            >
              {isPlaying ? <PauseIcon className="h-5 w-5" /> : <PlayIcon className="h-6 w-6 translate-x-[1px]" />}
            </button>
            <div className="min-w-0 flex-1">
              <WaveformSeek
                className="h-10"
                progress={progress}
                onSeek={hasAudio ? (fraction) => audio.seekFraction(data.audio_url, fraction) : undefined}
              />
              <div className="mt-1.5 flex items-center justify-between text-[11px] tabular-nums text-[#9a9a9a]">
                <span>{formatTime(cur)}</span>
                <span>{dur ? formatTime(dur) : data.audio_duration}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => audio.toggle(data.audio_url)}
              disabled={!hasAudio}
              className={`hidden shrink-0 items-center gap-2 rounded-full border border-white/20 px-5 py-3 text-sm font-medium text-white transition hover:bg-white/10 sm:inline-flex ${hasAudio ? "" : "opacity-50"}`}
            >
              <HeadphonesIcon className="h-4 w-4" />
              {isPlaying ? "Pause" : "Listen Now"}
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

function RowLead({ topic }) {
  const Icon = LAW_ICONS[topic.icon_key] || BookIcon;
  return (
    <>
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/75 sm:h-14 sm:w-14">
        <Icon className="h-5 w-5 sm:h-6 sm:w-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-white sm:text-lg">{topic.title}</span>
        <span className="mt-1 block text-[13px] leading-6 text-[#8f8f8f] sm:text-sm">{topic.body}</span>
      </span>
    </>
  );
}

const ROW_PILL =
  "inline-flex items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-white/10";

function LawRow({ topic, audio, onOpenVideos }) {
  const actionType = topic.action_type || "audio";
  const hasAudio = Boolean(topic.audio_url);
  const isPlaying = hasAudio && audio.url === topic.audio_url && audio.playing;

  // Simple audio row: the whole card toggles playback.
  if (actionType === "audio") {
    return (
      <button
        type="button"
        onClick={() => audio.toggle(topic.audio_url)}
        className="group flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4 text-left transition hover:border-white/20 hover:bg-white/[0.05] sm:gap-5 sm:px-6 sm:py-5"
      >
        <RowLead topic={topic} />
        <span className="hidden shrink-0 items-center gap-4 sm:flex">
          <span className={`flex h-11 w-11 items-center justify-center rounded-full border border-white/20 text-white/80 transition group-hover:bg-white/10 ${hasAudio ? "" : "opacity-50"}`}>
            {isPlaying ? <PauseIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4 translate-x-[1px]" />}
          </span>
          <span className="text-right leading-tight text-[#9a9a9a]">
            <span className="block text-[13px]">Audio</span>
            <span className="block text-[13px]">{topic.audio_duration || "--:--"}</span>
          </span>
          <ChevronRight className="h-4 w-4 text-[#6e6e6e]" />
        </span>
        <span className="flex shrink-0 items-center gap-2 sm:hidden">
          <span className={`flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white/80 ${hasAudio ? "" : "opacity-50"}`}>
            {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5 translate-x-[1px]" />}
          </span>
          <ChevronRight className="h-4 w-4 text-[#6e6e6e]" />
        </span>
      </button>
    );
  }

  // PDF / video rows: two action buttons on the right.
  const isPdf = actionType === "pdf";
  const hasPdf = Boolean(topic.pdf_url);
  return (
    <div className="flex w-full items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4 sm:gap-5 sm:px-6 sm:py-5">
      <RowLead topic={topic} />
      <div className="flex shrink-0 flex-col gap-2">
        {isPdf ? (
          <a
            href={hasPdf ? topic.pdf_url : undefined}
            target="_blank"
            rel="noreferrer"
            download
            aria-disabled={!hasPdf}
            className={`${ROW_PILL} w-[150px] ${hasPdf ? "" : "pointer-events-none opacity-50"}`}
          >
            <DownloadIcon className="h-4 w-4" />
            Download PDF
          </a>
        ) : (
          <button type="button" onClick={onOpenVideos} className={`${ROW_PILL} w-[150px]`}>
            <PlayIcon className="h-3.5 w-3.5 translate-x-[0.5px]" />
            Get Videos
          </button>
        )}
        <button
          type="button"
          onClick={() => audio.toggle(topic.audio_url)}
          disabled={!hasAudio}
          className={`${ROW_PILL} w-[150px] ${hasAudio ? "" : "opacity-50"}`}
        >
          <HeadphonesIcon className="h-4 w-4" />
          {isPlaying ? "Pause" : "Listen Guide"}
        </button>
      </div>
    </div>
  );
}

function VideoRow({ video, index }) {
  const href = video.video_url || undefined;
  const Wrapper = href ? "a" : "div";
  const linkProps = href ? { href, target: "_blank", rel: "noreferrer" } : {};
  return (
    <Wrapper
      {...linkProps}
      className="group flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-3 transition hover:border-white/20 hover:bg-white/[0.05] sm:gap-4 sm:px-4"
    >
      <span className="relative h-14 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-[#111] sm:h-16 sm:w-24">
        {video.thumbnail_url ? (
          <img src={video.thumbnail_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-white/35">
            <VideoIcon className="h-6 w-6" />
          </span>
        )}
        {video.duration ? (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {video.duration}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-white sm:text-[15px]">{index + 1}. {video.title}</span>
        <span className="mt-1 block text-[12px] leading-5 text-[#8f8f8f] sm:text-[13px]">{video.description}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 sm:gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/20 text-white/80 transition group-hover:bg-white/10">
          <PlayIcon className="h-4 w-4 translate-x-[1px]" />
        </span>
        <ChevronRight className="h-4 w-4 text-[#6e6e6e]" />
      </span>
    </Wrapper>
  );
}

function VideoDetailPanel({ topic, audio, onBack }) {
  const hasAudio = Boolean(topic.audio_url);
  const active = hasAudio && audio.url === topic.audio_url;
  const isPlaying = active && audio.playing;
  const cur = active ? audio.currentTime : 0;
  const dur = active ? audio.duration : 0;
  const progress = active && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  const videos = topic.videos || [];

  return (
    <div className="nd-view">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back
      </button>

      {/* Header + Listen Guide */}
      <div className="grid gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6 lg:grid-cols-[1fr_0.82fr] lg:items-center">
        <div className="flex items-start gap-4">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.04] text-white/80">
            <VideoIcon className="h-7 w-7" />
          </span>
          <div>
            <h3 className="text-xl font-black text-white sm:text-2xl">{topic.title}</h3>
            <p className="mt-1 text-[13px] leading-6 text-[#8f8f8f] sm:text-sm">{topic.body}</p>
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center gap-2 text-white">
            <HeadphonesIcon className="h-5 w-5" />
            <span className="text-sm font-semibold">Listen Guide</span>
          </div>
          {topic.audio_note ? (
            <p className="mt-2 text-[12px] leading-5 text-[#8f8f8f]">{topic.audio_note}</p>
          ) : null}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => audio.toggle(topic.audio_url)}
              disabled={!hasAudio}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/25 text-white transition hover:bg-white/10 ${hasAudio ? "" : "opacity-50"}`}
              aria-label={isPlaying ? "Pause guide" : "Play guide"}
            >
              {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-4 w-4 translate-x-[1px]" />}
            </button>
            <LinearSeek
              className="h-3 min-w-0 flex-1"
              progress={progress}
              onSeek={hasAudio ? (fraction) => audio.seekFraction(topic.audio_url, fraction) : undefined}
            />
            <span className="shrink-0 text-[11px] tabular-nums text-[#9a9a9a]">
              {formatTime(cur)} / {dur ? formatTime(dur) : topic.audio_duration || "0:00"}
            </span>
          </div>
        </div>
      </div>

      {/* Video examples */}
      <div className="mt-6 flex items-center justify-between">
        <div className="flex items-center gap-2 text-white">
          <VideoIcon className="h-5 w-5" />
          <span className="text-[13px] font-semibold uppercase tracking-[0.2em]">Video Examples</span>
        </div>
        {topic.view_all_url ? (
          <a href={topic.view_all_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-white/10">
            View All <ArrowRight className="h-4 w-4" />
          </a>
        ) : (
          <span className="inline-flex items-center gap-2 text-[13px] font-medium text-white/70">
            View All <ArrowRight className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {videos.length === 0 ? (
          <p className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-6 text-center text-sm text-[#8f8f8f]">
            No videos have been added yet.
          </p>
        ) : (
          videos.map((video, index) => (
            <VideoRow key={video.id ?? `${video.title}-${index}`} video={video} index={index} />
          ))
        )}
      </div>
    </div>
  );
}

function LawsView({ data, instagram, audio }) {
  const [videoTopic, setVideoTopic] = useState(null);
  const topics = data.topics || [];

  const openVideos = (topic) => {
    setVideoTopic(topic);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const closeVideos = () => {
    setVideoTopic(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <article className="nd-view overflow-hidden rounded-[28px] border border-white/10 bg-[#070707] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.55)] sm:p-10">
      {videoTopic ? (
        <VideoDetailPanel topic={videoTopic} audio={audio} onBack={closeVideos} />
      ) : (
        <>
          {/* Header — full-bleed hero with the copy overlaid on the image */}
          <div className="relative flex min-h-[420px] overflow-hidden rounded-[22px] border border-white/10 sm:min-h-[520px]">
            <img
              src={data.hero_image_url || heroLaws}
              alt="Stacked law books — Criminal Procedure Code, Indian Penal Code, Constitution of India — with scales of justice and a gavel"
              className="absolute inset-0 h-full w-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#060606] via-[#060606]/80 to-[#060606]/15" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#060606]/90 via-transparent to-[#060606]/40" />
            <div className="relative z-10 flex w-full max-w-xl flex-col justify-center px-6 py-10 sm:px-10 sm:py-14">
              <Kicker className="self-start">{data.section_label}</Kicker>
              <h2 className="mt-5 text-[2.1rem] font-black leading-[1.03] tracking-[-0.035em] text-white drop-shadow-[0_2px_18px_rgba(0,0,0,0.6)] sm:text-[3.1rem]">
                {data.title}
              </h2>
              <p className="mt-5 max-w-md text-[15px] leading-7 text-[#d6d6d6] drop-shadow-[0_1px_10px_rgba(0,0,0,0.6)] sm:text-base">
                {data.subtitle}
              </p>
            </div>
          </div>

          {/* Rows */}
          <div className="mt-8 space-y-3">
            {topics.map((topic, index) => (
              <LawRow
                key={topic.id ?? `${topic.title}-${index}`}
                topic={topic}
                audio={audio}
                onOpenVideos={() => openVideos(topic)}
              />
            ))}
          </div>

          {/* Instagram CTA */}
          {instagram.enabled ? (
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-4">
                  <span className="shrink-0 pt-0.5 text-white/75">
                    <MegaphoneIcon className="h-9 w-9" />
                  </span>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#8c8c8c]">{data.cta_kicker}</p>
                    <p className="mt-1 text-[15px] font-bold text-white">{data.cta_title}</p>
                    <p className="mt-1 max-w-md text-[13px] leading-6 text-[#8f8f8f]">{data.cta_body}</p>
                  </div>
                </div>
                <a
                  href={instagram.url || DEFAULT_INSTAGRAM_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-white/25 px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  <InstagramIcon className="h-5 w-5" />
                  Follow on Instagram
                  <ChevronRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* View 3 — FIR Process Across India                                   */
/* ------------------------------------------------------------------ */

function StatMarker({ kind }) {
  if (kind === "completed") {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    );
  }
  if (kind === "progress") {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90" fill="none">
          <circle cx="12" cy="12" r="8" stroke="rgba(255,255,255,0.18)" strokeWidth="2.5" />
          <circle cx="12" cy="12" r="8" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="34 50" />
        </svg>
      </span>
    );
  }
  if (kind === "done") {
    return (
      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
        <span className="h-5 w-5 rounded-full bg-white/85" />
      </span>
    );
  }
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-white/[0.04]">
      <span className="h-5 w-5 rounded-full border-2 border-white/40" />
    </span>
  );
}

function statusDotClass(status) {
  if (status === "Completed") return "bg-white";
  if (status === "In Progress") return "border-2 border-white/50";
  return "border-2 border-white/30";
}

function TrackerView({ data }) {
  const stats = [
    { label: "Total FIRs Filed", value: data.stats.total_filed, note: "(So Far)", kind: "completed" },
    { label: "In Progress", value: data.stats.in_progress, note: "(Locations)", kind: "progress" },
    { label: "Completed", value: data.stats.completed, note: "(Locations)", kind: "done" },
    { label: "Planned / Upcoming", value: data.stats.planned, note: "(Locations)", kind: "planned" },
  ];
  return (
    <article className="nd-view overflow-hidden rounded-[28px] border border-white/10 bg-[#070707] p-5 shadow-[0_30px_90px_rgba(0,0,0,0.55)] sm:p-10">
      {/* Header */}
      <div className="relative grid gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:items-start">
        <div>
          <Kicker>{data.section_label}</Kicker>
          <h2 className="mt-5 text-[2.3rem] font-black leading-[1.0] tracking-[-0.035em] text-white sm:text-[3.4rem]">
            {data.title}
          </h2>
          <p className="mt-5 max-w-lg text-[15px] leading-7 text-[#8f8f8f] sm:text-base">{data.subtitle}</p>
        </div>
        <div className="relative hidden aspect-[16/10] overflow-hidden rounded-2xl border border-white/10 lg:block">
          {data.hero_image_url ? (
            <img src={data.hero_image_url} alt="Supreme Court of India" className="h-full w-full object-cover object-center" />
          ) : (
            <SupremeCourtHero className="h-full w-full" />
          )}
          <p className="absolute bottom-4 right-4 text-right text-[11px] font-semibold uppercase leading-5 tracking-[0.22em] text-white/60">
            {data.tagline}
          </p>
        </div>
      </div>

      {/* Map + stats */}
      <div className="mt-8 grid gap-5 lg:grid-cols-[1.08fr_0.92fr]">
        <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#050505] p-4">
          <div className="absolute inset-0 opacity-[0.3] [background-image:linear-gradient(rgba(255,255,255,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:28px_28px]" />
          <div className="absolute left-4 top-4 z-10 flex flex-col items-center text-white/55">
            <svg viewBox="0 0 40 52" className="h-11 w-9" aria-hidden="true">
              <path d="M20 4 26 24 20 19 14 24 20 4Z" fill="rgba(255,255,255,0.9)" />
              <path d="M20 40 14 24 20 29 26 24 20 40Z" fill="rgba(255,255,255,0.28)" />
            </svg>
            <span className="text-[11px] font-bold tracking-[0.2em]">N</span>
          </div>
          <IndiaMap className="relative mx-auto h-[400px] w-full sm:h-[460px]" />
        </div>

        <div className="flex flex-col gap-3">
          {stats.map((s) => (
            <div key={s.label} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-4">
              <StatMarker kind={s.kind} />
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8c8c8c]">{s.label}</p>
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
            <PinFilledIcon className="h-5 w-5" />
            <span className="text-[13px] font-semibold uppercase tracking-[0.24em]">Latest Updates</span>
          </div>
          {data.full_tracker_url ? (
            <a href={data.full_tracker_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-white/10">
              View All <ArrowRight className="h-4 w-4" />
            </a>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-[13px] font-medium text-white/80">
              View All <ArrowRight className="h-4 w-4" />
            </span>
          )}
        </div>
        <div className="mt-4 divide-y divide-white/[0.06]">
          {data.updates.map((u, index) => {
            const city = u.region ? `${u.city}, ${u.region}` : u.city;
            const status = u.status_display || u.status;
            return (
              <div key={u.id ?? `${city}-${index}`} className="flex items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold uppercase tracking-[0.04em] text-white">{city}</p>
                  <p className="text-[12px] text-[#8f8f8f]">{u.status_note}</p>
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.03] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#cfcfcf] sm:px-3 sm:text-[11px] sm:tracking-[0.14em]">
                    <span className={`h-2.5 w-2.5 rounded-full ${statusDotClass(status)}`} />
                    {status}
                  </span>
                  <span className="w-[72px] text-right text-[12px] text-[#9a9a9a]">{u.date}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full tracker CTA */}
      <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-5 sm:p-6">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="shrink-0 text-white/70">
              <PinFilledIcon className="h-9 w-9" />
            </span>
            <div>
              <p className="text-[13px] font-semibold uppercase tracking-[0.18em] text-white">{data.updates_cta_kicker}</p>
              <p className="mt-1 max-w-md text-[13px] leading-6 text-[#8f8f8f]">{data.updates_cta_body}</p>
            </div>
          </div>
          {data.full_tracker_url ? (
            <a href={data.full_tracker_url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10">
              <ExternalIcon className="h-5 w-5" />
              View Full Tracker
              <ChevronRight className="h-4 w-4" />
            </a>
          ) : (
            <span className="inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-white/25 px-5 py-3.5 text-sm font-semibold text-white/80">
              <ExternalIcon className="h-5 w-5" />
              View Full Tracker
              <ChevronRight className="h-4 w-4" />
            </span>
          )}
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
  const audio = useAudioPlayer();

  const [content, setContent] = useState(DEFAULTS);

  useEffect(() => {
    let active = true;
    getNationalDesk()
      .then((response) => {
        if (active) setContent(mergeContent(apiData(response, null)));
      })
      .catch(() => {
        if (active) setContent(DEFAULTS);
      });
    return () => {
      active = false;
    };
  }, []);

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
      <div className="mb-6 grid grid-cols-3 gap-1.5 rounded-2xl border border-white/10 bg-white/[0.02] p-1.5 sm:gap-2">
        {PAGES.map((p, i) => {
          const isActive = p.key === active;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => goTo(p.key)}
              aria-current={isActive ? "page" : undefined}
              className={`rounded-xl px-2 py-2.5 text-center text-[11px] font-semibold leading-tight transition sm:px-3 sm:text-sm ${
                isActive
                  ? "bg-white text-black shadow-[0_6px_18px_rgba(255,255,255,0.12)]"
                  : "text-[#b9b9b9] hover:bg-white/[0.06] hover:text-white"
              }`}
            >
              <span className="mr-1.5 text-[10px] opacity-60 sm:text-[11px]">0{i + 1}</span>
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Active view */}
      <div key={active}>
        {active === "file-fir" ? <FileFirView data={content.file_fir} audio={audio} /> : null}
        {active === "laws" ? <LawsView data={content.laws} instagram={content.instagram} audio={audio} /> : null}
        {active === "tracker" ? <TrackerView data={content.tracker} /> : null}
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
