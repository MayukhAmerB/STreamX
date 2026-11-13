import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

import { EMBED_ORIGIN, embedUrl, isValidVideoId, thumbnailUrl } from "./youtubeModel";

let warmed = false;

/** Open connections to YouTube when the visitor shows intent (hover / focus). */
function warmConnections() {
  if (warmed || typeof document === "undefined") return;
  warmed = true;
  for (const href of [EMBED_ORIGIN, "https://www.google.com", "https://i.ytimg.com"]) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = href;
    link.crossOrigin = "anonymous";
    document.head.appendChild(link);
  }
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 68 48" aria-hidden="true" className="yt-lite__play-icon">
      <path className="yt-lite__play-bg" d="M66.5 7.7A8.5 8.5 0 0 0 60.5 1.7C55.2.3 34 .3 34 .3S12.8.3 7.5 1.7A8.5 8.5 0 0 0 1.5 7.7C.1 13 .1 24 .1 24s0 11 1.4 16.3a8.5 8.5 0 0 0 6 6C12.8 47.7 34 47.7 34 47.7s21.2 0 26.5-1.4a8.5 8.5 0 0 0 6-6C67.9 35 67.9 24 67.9 24s0-11-1.4-16.3Z" />
      <path d="M45 24 27 14v20" fill="#fff" />
    </svg>
  );
}

/**
 * "Lite" YouTube player: a thumbnail and a play button until the visitor
 * clicks, and only then the youtube-nocookie iframe (autoplaying, since the
 * click is the user gesture). Nothing from YouTube's player, and none of its
 * cookies, loads before that. `ref.activate()` starts it programmatically.
 */
const LiteYouTubeEmbed = forwardRef(function LiteYouTubeEmbed(
  { videoId, title, isLive = false, autoActivate = false, priority = false, onActivate },
  ref,
) {
  const [activated, setActivated] = useState(Boolean(autoActivate));
  const [poster, setPoster] = useState("maxres");
  const buttonRef = useRef(null);

  // A different video resets to its thumbnail unless it was chosen with a click.
  useEffect(() => {
    setActivated(Boolean(autoActivate));
    setPoster("maxres");
  }, [videoId, autoActivate]);

  useImperativeHandle(ref, () => ({
    activate() {
      warmConnections();
      setActivated(true);
      onActivate?.();
    },
    focus() {
      buttonRef.current?.focus?.();
    },
  }));

  if (!isValidVideoId(videoId)) return null;
  const label = title || "YouTube video";

  if (activated) {
    return (
      <div className="yt-lite yt-lite--active">
        <iframe
          className="yt-lite__frame"
          src={embedUrl(videoId, { autoplay: true })}
          title={`${isLive ? "Live stream" : "Video"}: ${label}`}
          allow="autoplay; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }

  const highRes = thumbnailUrl(videoId, "maxres");
  const fallback = thumbnailUrl(videoId, "hq");
  return (
    <button
      ref={buttonRef}
      type="button"
      className="yt-lite"
      onClick={() => {
        warmConnections();
        setActivated(true);
        onActivate?.();
      }}
      onPointerEnter={warmConnections}
      onFocus={warmConnections}
      aria-label={`${isLive ? "Watch the live stream" : "Play video"}: ${label}`}
    >
      <img
        className="yt-lite__poster"
        src={poster === "maxres" ? highRes : fallback}
        alt=""
        width="1280"
        height="720"
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        // maxresdefault does not exist for every video: YouTube then serves a
        // 120x90 placeholder (or a 404); fall back to the always-present hq image.
        onLoad={(event) => {
          if (poster === "maxres" && event.currentTarget.naturalWidth <= 120) setPoster("hq");
        }}
        onError={() => {
          if (poster === "maxres") setPoster("hq");
        }}
      />
      <span className="yt-lite__shade" aria-hidden="true" />
      <span className="yt-lite__play" aria-hidden="true">
        <PlayIcon />
      </span>
    </button>
  );
});

export default LiteYouTubeEmbed;
