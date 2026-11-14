import "../features/youtube/YouTube.css";
import "./landing/sitePages.css";

import YouTubeShowcase, { LiveBadge, YouTubeGlyph } from "../features/youtube/YouTubeShowcase";
import { useYouTubeChannel } from "../features/youtube/youTubeStore";
import { WATCH_PAGE } from "../marketing/marketingContent";
import { Hand } from "../marketing/primitives";
import { Band, Column, EmptyState } from "../site-kit";

const FALLBACK_CHANNEL_URL = "https://www.youtube.com/@thesy3d";

/** /watch: the full YouTube player, every latest upload and the channel links (one g100 band). */
export default function WatchPage({ store, now }) {
  const { status, model, enabled } = useYouTubeChannel(store);
  const loading = status === "idle" || status === "loading";
  const title = model?.section.title || "Watch";
  const subtitle = model?.section.subtitle || WATCH_PAGE.fallbackSubtitle;

  return (
    <div className="sp sp-watch" data-page="watch">
      <section className="hp-hero hp-hero--page" aria-labelledby="sp-watch-title" data-live={model?.live ? "true" : undefined}>
        <p className="hp-kicker sp-watch__eyebrow">
          <YouTubeGlyph className="sp-watch__glyph" />
          <span className="hp-kicker__lead">{model?.channel?.handle ? `YouTube · ${model.channel.handle}` : "YouTube"}</span>
          {model?.live ? <LiveBadge /> : null}
        </p>
        <h1 id="sp-watch-title" className="hp-display">
          <span className="hp-display__line">
            {title.includes(" ") ? (
              <>
                {title.slice(0, title.lastIndexOf(" "))} <Hand>{title.slice(title.lastIndexOf(" ") + 1)}</Hand>
              </>
            ) : (
              <Hand>{title}</Hand>
            )}
          </span>
        </h1>
        <p className="hp-lead">{subtitle}</p>
      </section>
      <Band theme="g100" aria-label="Videos">
        <Column sm={4} md={8} lg={16} className="sp-watch__body">
          {loading ? (
            <>
              <div className="yt-skeleton" aria-hidden="true">
                <div className="yt-skeleton__player" />
              </div>
              <p className="sk-visually-hidden" role="status">
                Loading videos
              </p>
            </>
          ) : model ? (
            <>
              {/* Keeps the heading order h1 → h2 → h3 (the showcase titles are h3). */}
              <h2 className="sk-visually-hidden">Videos from the channel</h2>
              <YouTubeShowcase model={model} variant="page" now={now} withJsonLd />
            </>
          ) : (
            <EmptyState
              title={enabled ? "Videos can't be shown right now" : "Videos are not available"}
              body={
                enabled
                  ? "We couldn't reach YouTube just now. You can watch everything on the channel, or try again in a minute."
                  : "This section is switched off at the moment. Our courses and live classes are still open."
              }
              headingLevel={2}
              icon={<YouTubeGlyph className="sp-watch__glyph" />}
              action={
                enabled
                  ? { label: "Open the YouTube channel", href: FALLBACK_CHANNEL_URL, kind: "primary" }
                  : { label: "Browse courses", href: "/courses", kind: "primary" }
              }
            />
          )}
        </Column>
      </Band>
    </div>
  );
}
