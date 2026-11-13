import "./YouTube.css";

import { useId, useMemo, useRef, useState } from "react";

import LiteYouTubeEmbed from "./LiteYouTubeEmbed";
import {
  buildVideoJsonLd,
  formatLongDate,
  formatRelativeDate,
  selectMainVideo,
  serializeJsonLd,
  watchUrl,
} from "./youtubeModel";
import { prefersReducedMotion } from "./watchAnchor";

export function YouTubeGlyph({ className = "" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="currentColor"
        d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"
      />
    </svg>
  );
}

function ExternalArrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="yt-icon-sm" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5H3.5v9h9V10M9 3h4v4M13 3 7.5 8.5" />
    </svg>
  );
}

export function LiveBadge({ className = "" }) {
  return (
    <span className={`yt-live-badge ${className}`.trim()}>
      <span className="yt-live-dot" aria-hidden="true" />
      Live now
    </span>
  );
}

function ChannelActions({ channel, compact = false }) {
  return (
    <div className={`yt-actions${compact ? " yt-actions--compact" : ""}`}>
      <a className="yt-btn yt-btn--primary" href={channel.subscribeUrl} target="_blank" rel="noopener noreferrer">
        <YouTubeGlyph className="yt-icon" />
        Subscribe on YouTube
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      <a className="yt-btn yt-btn--ghost" href={channel.url} target="_blank" rel="noopener noreferrer">
        View channel
        <ExternalArrow />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </div>
  );
}

function VideoCard({ video, selected, onSelect, now }) {
  const relative = formatRelativeDate(video.publishedAt, now);
  return (
    <li className="yt-card-item">
      <button
        type="button"
        className={`yt-card${selected ? " is-selected" : ""}`}
        onClick={() => onSelect(video)}
        aria-pressed={selected}
        aria-label={`Play ${video.title}${relative ? `, published ${relative}` : ""}`}
      >
        <span className="yt-card__thumb">
          <img src={video.thumbnail} alt="" width="480" height="360" loading="lazy" decoding="async" />
          {selected ? <span className="yt-card__now">Now playing</span> : null}
        </span>
        <span className="yt-card__body">
          <span className="yt-card__title">{video.title}</span>
          {relative ? (
            <time className="yt-card__date" dateTime={video.publishedAt}>
              {relative}
            </time>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The YouTube block used on the landing page (`variant="section"`) and the
 * Watch page (`variant="page"`): a lite player (live stream when live, else
 * the featured upload), its details, the latest uploads (click to play in the
 * main player) and the channel actions. Render it only with a model.
 */
export default function YouTubeShowcase({ model, variant = "section", now = Date.now(), withJsonLd = false }) {
  const main = useMemo(() => selectMainVideo(model), [model]);
  // { video, play }: the upload the visitor picked (play = start it right away).
  const [selection, setSelection] = useState(null);
  const playerRef = useRef(null);
  const playerRegionRef = useRef(null);
  const listId = useId();

  if (!model || !main) return null;
  // Picking the live stream (or nothing) shows the main video; a live stream always leads.
  const pickedOther = selection && !(model.live && selection.video.videoId === model.live.videoId);
  const current = pickedOther ? selection.video : main;
  const autoPlay = Boolean(selection?.play && selection.video.videoId === current.videoId);
  const isLiveCurrent = Boolean(model.live && current.videoId === model.live.videoId);
  const videos = variant === "section" ? model.latest.slice(0, 6) : model.latest;
  const jsonLd = withJsonLd ? buildVideoJsonLd({ ...(model.featured || {}), isLive: false }, model.channel) : null;

  const select = (video) => {
    setSelection({ video: { ...video, isLive: false }, play: true });
    playerRegionRef.current?.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const joinLive = () => {
    if (isLiveCurrent) {
      playerRef.current?.activate();
      return;
    }
    setSelection({ video: { ...model.live, isLive: true }, play: true });
  };

  return (
    <div className={`yt-showcase yt-showcase--${variant}${model.live ? " is-live" : ""}`}>
      <div className="yt-stage">
        <div className="yt-player" ref={playerRegionRef}>
          {isLiveCurrent ? <LiveBadge className="yt-player__badge" /> : null}
          <LiteYouTubeEmbed
            ref={playerRef}
            key={current.videoId}
            videoId={current.videoId}
            title={current.title}
            isLive={isLiveCurrent}
            autoActivate={autoPlay}
            priority={variant === "page"}
          />
        </div>

        <div className="yt-meta">
          <p className="yt-meta__kicker">
            {isLiveCurrent ? (
              <span className="yt-meta__live">Streaming now on YouTube</span>
            ) : pickedOther ? (
              "Now playing"
            ) : (
              "Featured video"
            )}
          </p>
          <h3 className="yt-meta__title">{current.title}</h3>
          {!isLiveCurrent && current.publishedAt ? (
            <p className="yt-meta__date">
              Published <time dateTime={current.publishedAt}>{formatLongDate(current.publishedAt)}</time>
              <span aria-hidden="true"> · </span>
              {formatRelativeDate(current.publishedAt, now)}
            </p>
          ) : null}
          <div className="yt-meta__actions">
            {isLiveCurrent ? (
              <button type="button" className="yt-btn yt-btn--live" onClick={joinLive}>
                <span className="yt-live-dot yt-live-dot--light" aria-hidden="true" />
                Join the live stream
              </button>
            ) : null}
            <a className="yt-link" href={watchUrl(current.videoId)} target="_blank" rel="noopener noreferrer">
              {isLiveCurrent ? "Open on YouTube with live chat" : "Watch on YouTube"}
              <ExternalArrow />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </div>
        </div>
      </div>

      {videos.length > 1 || (videos.length === 1 && videos[0].videoId !== current.videoId) ? (
        <div className="yt-latest">
          <div className="yt-latest__head">
            <h3 className="yt-latest__title" id={listId}>
              Latest videos
            </h3>
            <span className="yt-latest__hint" aria-hidden="true">
              {variant === "section" ? "Swipe or select to play" : `${videos.length} videos`}
            </span>
          </div>
          <ul className="yt-latest__list" aria-labelledby={listId}>
            {videos.map((video) => (
              <VideoCard
                key={video.videoId}
                video={video}
                selected={video.videoId === current.videoId}
                onSelect={select}
                now={now}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="yt-channel">
        <div className="yt-channel__id">
          <span className="yt-channel__mark" aria-hidden="true">
            <YouTubeGlyph className="yt-icon" />
          </span>
          <span>
            <span className="yt-channel__name">{model.channel.title}</span>
            {model.channel.handle ? <span className="yt-channel__handle">{model.channel.handle}</span> : null}
          </span>
        </div>
        <ChannelActions channel={model.channel} compact={variant === "section"} />
      </div>

      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      ) : null}
    </div>
  );
}
