import "./YouTube.css";

import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";

import { siteBrand } from "../../config/siteBrand";
import { scrollToWatchSection, WATCH_SECTION_ID } from "./watchAnchor";
import YouTubeShowcase, { LiveBadge, YouTubeGlyph } from "./YouTubeShowcase";
import { useYouTubeChannel } from "./youTubeStore";

function SectionFrame({ children, labelledBy, live = false }) {
  return (
    <section
      id={WATCH_SECTION_ID}
      aria-labelledby={labelledBy}
      className={`yt-section relative mx-auto max-w-6xl scroll-mt-24 overflow-hidden rounded-[22px] border bg-[#070707] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-7 ${
        live ? "border-red-500/30" : "border-white/10"
      }`}
    >
      {children}
    </section>
  );
}

/**
 * Landing-page "Watch" section, placed right after the hero. Keeps its space
 * with a skeleton while the first answer loads (no layout shift) and renders
 * nothing at all when the server says the section is off or unavailable.
 */
export default function YouTubeSection({ store, now }) {
  const { status, model } = useYouTubeChannel(store);
  const { hash } = useLocation();
  const scrolledFor = useRef("");

  // /#watch deep links: scroll once the section exists (it renders after data arrives).
  useEffect(() => {
    if (hash !== `#${WATCH_SECTION_ID}` || !model || scrolledFor.current === hash) return;
    scrolledFor.current = hash;
    window.requestAnimationFrame?.(() => scrollToWatchSection());
  }, [hash, model]);

  if (!siteBrand.youtube) return null;

  if (status === "idle" || status === "loading") {
    return (
      <div className="relative mx-auto max-w-6xl rounded-[22px] border border-white/10 bg-[#070707] p-5 sm:p-7" aria-hidden="true">
        <div className="mb-6 h-3 w-40 rounded bg-[#121212]" />
        <div className="mb-7 h-8 w-64 max-w-full rounded bg-[#121212]" />
        <div className="yt-skeleton">
          <div className="yt-skeleton__player" />
          <div className="hidden gap-3 lg:grid">
            <div className="yt-skeleton__line" />
            <div className="yt-skeleton__line" style={{ width: "85%" }} />
          </div>
        </div>
      </div>
    );
  }

  if (!model) return null;
  const headingId = "watch-heading";

  return (
    <SectionFrame labelledBy={headingId} live={Boolean(model.live)}>
      <div className="mb-6 flex flex-col gap-4 sm:mb-7 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <span className="h-px w-10 bg-white/70" aria-hidden="true" />
            <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[#A3A3A3]">
              <YouTubeGlyph className="h-4 w-4 text-[#ff2d3f]" />
              {model.channel.handle ? `YouTube · ${model.channel.handle}` : "YouTube"}
            </span>
            {model.live ? <LiveBadge /> : null}
          </div>
          <h2 id={headingId} className="font-reference text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            {model.section.title}
          </h2>
          {model.section.subtitle ? (
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[#A7A7A7] sm:text-base">{model.section.subtitle}</p>
          ) : null}
        </div>
        <Link
          to="/watch"
          className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-semibold text-white transition hover:border-white/35 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f3e2b3]"
        >
          All videos
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </Link>
      </div>
      <YouTubeShowcase model={model} variant="section" now={now} withJsonLd />
    </SectionFrame>
  );
}
