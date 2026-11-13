// Pure helpers for the website's YouTube section (no React, no network).
// The server already validates everything; the client validates again so a
// bad payload can never reach an iframe src or an <img> URL.

export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
export const EMBED_ORIGIN = "https://www.youtube-nocookie.com";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const EMBED_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
const ID_PATH_PREFIXES = new Set(["live", "shorts", "embed", "v", "e"]);
const CHANNEL_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

export function isValidVideoId(value) {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value);
}

/** 11-character id from a bare id or a watch / youtu.be / live / shorts / embed URL, else null. */
export function parseVideoId(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) return null;
  if (isValidVideoId(raw)) return raw;
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let candidate = null;
  if (SHORT_HOSTS.has(host)) {
    candidate = segments[0] || null;
  } else if (YOUTUBE_HOSTS.has(host) || EMBED_HOSTS.has(host)) {
    if (YOUTUBE_HOSTS.has(host) && segments.length === 1 && segments[0] === "watch") {
      const values = url.searchParams.getAll("v");
      candidate = values.length === 1 ? values[0] : null;
    } else if (segments.length >= 2 && ID_PATH_PREFIXES.has(segments[0].toLowerCase())) {
      if (EMBED_HOSTS.has(host) && segments[0].toLowerCase() !== "embed") return null;
      candidate = segments[1];
    }
  }
  return isValidVideoId(candidate) ? candidate : null;
}

/** Privacy-enhanced embed URL; autoplay only after the visitor clicked play. */
export function embedUrl(videoId, { autoplay = true } = {}) {
  if (!isValidVideoId(videoId)) return null;
  const params = new URLSearchParams({ rel: "0", modestbranding: "1", playsinline: "1" });
  if (autoplay) params.set("autoplay", "1");
  return `${EMBED_ORIGIN}/embed/${videoId}?${params.toString()}`;
}

/** i.ytimg.com thumbnail: "hq" (480x360, always exists) or "maxres" (1280x720, may not). */
export function thumbnailUrl(videoId, quality = "hq") {
  if (!isValidVideoId(videoId)) return null;
  const file = quality === "maxres" ? "maxresdefault" : quality === "sd" ? "sddefault" : quality === "mq" ? "mqdefault" : "hqdefault";
  return `https://i.ytimg.com/vi/${videoId}/${file}.jpg`;
}

export function watchUrl(videoId) {
  return isValidVideoId(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : null;
}

function safeChannelUrl(value, fallback) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" && CHANNEL_HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.port) {
      return url.toString();
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

function plainText(value, max = 200) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text;
}

function validDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeVideo(video) {
  if (!video || !isValidVideoId(video.video_id)) return null;
  return {
    videoId: video.video_id,
    title: plainText(video.title) || "YouTube video",
    publishedAt: validDate(video.published_at),
    thumbnail: thumbnailUrl(video.video_id),
  };
}

/**
 * The API payload -> what the UI renders, or null when the section must be
 * hidden (disabled, unavailable, malformed, or nothing playable).
 */
export function normalizeYouTubePayload(data) {
  if (!data || typeof data !== "object" || data.enabled !== true || data.available !== true) return null;
  const latest = (Array.isArray(data.latest) ? data.latest : []).map(normalizeVideo).filter(Boolean);
  const featured = normalizeVideo(data.featured) || latest[0] || null;
  const liveId = data.live?.is_live === true && isValidVideoId(data.live.video_id) ? data.live.video_id : null;
  const live = liveId
    ? { videoId: liveId, title: plainText(data.live.title) || "Live now on YouTube", thumbnail: thumbnailUrl(liveId) }
    : null;
  if (!featured && !live) return null;
  const handle = /^@[A-Za-z0-9._-]{3,100}$/.test(String(data.channel?.handle || "")) ? data.channel.handle : "";
  const channelUrl = safeChannelUrl(data.channel?.url, "https://www.youtube.com/@thesy3d");
  return {
    section: {
      title: plainText(data.section?.title, 120) || "Watch",
      subtitle: plainText(data.section?.subtitle, 240),
    },
    channel: {
      title: plainText(data.channel?.title, 120) || "YouTube",
      handle,
      url: channelUrl,
      subscribeUrl: safeChannelUrl(data.channel?.subscribe_url, channelUrl),
    },
    live,
    featured,
    latest,
    fetchedAt: validDate(data.fetched_at),
  };
}

/** The main player's video: the live stream when live, else the featured upload. */
export function selectMainVideo(model) {
  if (!model) return null;
  if (model.live) return { ...model.live, isLive: true, publishedAt: null };
  return model.featured ? { ...model.featured, isLive: false } : null;
}

const RELATIVE_UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 weeks ago", "yesterday", "just now". */
export function formatRelativeDate(iso, now = Date.now()) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** "11 Oct 2026" for machine-readable dates shown to people. */
export function formatLongDate(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(time);
}

/**
 * schema.org VideoObject for a published upload. Google requires name,
 * thumbnailUrl and uploadDate, all of which the public feed provides, so no
 * API key is needed. Live streams are skipped: a valid BroadcastEvent needs a
 * start time the feed does not give.
 */
export function buildVideoJsonLd(video, channel) {
  if (!video || video.isLive || !isValidVideoId(video.videoId) || !video.publishedAt) return null;
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: video.title,
    description: `${video.title} - from the ${channel?.title || "YouTube"} channel on YouTube.`,
    thumbnailUrl: [thumbnailUrl(video.videoId, "hq"), thumbnailUrl(video.videoId, "maxres")],
    uploadDate: video.publishedAt,
    embedUrl: `${EMBED_ORIGIN}/embed/${video.videoId}`,
    url: watchUrl(video.videoId),
    publisher: channel?.url ? { "@type": "Organization", name: channel.title, url: channel.url } : undefined,
  };
}

/** JSON for an inline <script type="application/ld+json">, safe against "</script>". */
export function serializeJsonLd(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
