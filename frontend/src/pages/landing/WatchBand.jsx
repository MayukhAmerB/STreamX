import "../../features/youtube/YouTube.css";

import { siteBrand } from "../../config/siteBrand";
import { useWatchDeepLink } from "../../features/youtube/YouTubeSection";
import YouTubeShowcase, { LiveBadge, YouTubeGlyph } from "../../features/youtube/YouTubeShowcase";
import { WATCH_SECTION_ID } from "../../features/youtube/watchAnchor";
import { Band, Column, Link, Skeleton } from "../../site-kit";

/** True while the Watch band takes space: loading (reserved) or a playable model. */
export function watchBandVisible(youtube) {
  if (!siteBrand.youtube || youtube?.enabled === false) return false;
  return youtube?.status === "idle" || youtube?.status === "loading" || Boolean(youtube?.model);
}

/**
 * Band 3 (`id="watch"`): the YouTube channel. Every string, link and the
 * JSON-LD come from the shared showcase; the band only restyles it (player
 * cols 1-11 and details 12-16 at lg, latest videos 6-up, swipe on phones).
 * YouTube red stays inside the player glyph and the on-air badge.
 */
export default function WatchBand({ theme = "g100", youtube, now }) {
  const model = youtube?.model || null;
  useWatchDeepLink(model);

  if (!watchBandVisible(youtube)) return null;

  if (!model) {
    return (
      <Band theme={theme} className="lp-band lp-watch" aria-label="Watch">
        <Column sm={4} md={8} lg={16}>
          <div className="lp-watch__skeleton" aria-hidden="true">
            <div className="lp-watch__skeleton-player" />
          </div>
          <Skeleton lines={2} label="Loading videos" />
        </Column>
      </Band>
    );
  }

  const headingId = "watch-heading";
  return (
    <Band theme={theme} id={WATCH_SECTION_ID} className="lp-band lp-watch" labelledBy={headingId} data-live={model.live ? "true" : undefined}>
      <Column sm={4} md={8} lg={16} className="lp-watch__head">
        <div className="lp-heading">
          <p className="lp-eyebrow lp-watch__kicker">
            <YouTubeGlyph className="lp-watch__glyph" />
            {model.channel.handle ? `YouTube · ${model.channel.handle}` : "YouTube"}
            {model.live ? <LiveBadge /> : null}
          </p>
          <h2 id={headingId} className="lp-h2">
            {model.section.title}
          </h2>
          {model.section.subtitle ? <p className="lp-lead">{model.section.subtitle}</p> : null}
        </div>
        <Link href="/watch" arrow size="lg" className="lp-watch__all">
          All videos
        </Link>
      </Column>
      <Column sm={4} md={8} lg={16}>
        <YouTubeShowcase model={model} variant="section" now={now} withJsonLd />
      </Column>
    </Band>
  );
}
