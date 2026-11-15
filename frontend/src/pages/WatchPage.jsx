import "../features/youtube/YouTube.css";

import { Link } from "react-router-dom";

import PageShell from "../components/PageShell";
import YouTubeShowcase, { YouTubeGlyph } from "../features/youtube/YouTubeShowcase";
import { useYouTubeChannel } from "../features/youtube/youTubeStore";

const FALLBACK_CHANNEL_URL = "https://www.youtube.com/@thesy3d";

function Panel({ children, live = false }) {
  return (
    <div
      className={`relative overflow-hidden rounded-[22px] border bg-[#070707] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.28)] sm:p-7 ${
        live ? "border-red-500/30" : "border-white/10"
      }`}
    >
      {children}
    </div>
  );
}

/** /watch: the full YouTube player, every latest upload and the channel links. */
export default function WatchPage({ store, now }) {
  const { status, model, enabled } = useYouTubeChannel(store);
  const loading = status === "idle" || status === "loading";

  return (
    <PageShell
      title={model?.section.title || "Watch"}
      subtitle={
        model?.section.subtitle ||
        "Free live classes, investigations and talks from the Al Syed YouTube channel."
      }
      badge="YouTube"
    >
      <div>
        {loading ? (
          <Panel>
            <div className="yt-skeleton" aria-hidden="true">
              <div className="yt-skeleton__player" />
            </div>
            <p className="sr-only" role="status">
              Loading videos
            </p>
          </Panel>
        ) : model ? (
          <Panel live={Boolean(model.live)}>
            <YouTubeShowcase model={model} variant="page" now={now} withJsonLd />
          </Panel>
        ) : (
          <Panel>
            <div className="flex flex-col items-start gap-4 py-6 sm:py-10">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-[#0d0d0d] text-[#ff2d3f]">
                <YouTubeGlyph className="h-6 w-6" />
              </span>
              <h2 className="text-2xl font-extrabold tracking-tight text-white">
                {enabled ? "Videos can't be shown right now" : "Videos are not available"}
              </h2>
              <p className="max-w-xl text-sm leading-7 text-[#A7A7A7]">
                {enabled
                  ? "We couldn't reach YouTube just now. You can watch everything on the channel, or try again in a minute."
                  : "This section is switched off at the moment. Our courses and live classes are still open."}
              </p>
              <div className="flex flex-wrap gap-3">
                {enabled ? (
                  <a className="yt-btn yt-btn--primary" href={FALLBACK_CHANNEL_URL} target="_blank" rel="noopener noreferrer">
                    <YouTubeGlyph className="yt-icon" />
                    Open the YouTube channel
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : null}
                <Link to="/courses" className="yt-btn yt-btn--ghost">
                  Browse courses
                </Link>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </PageShell>
  );
}
