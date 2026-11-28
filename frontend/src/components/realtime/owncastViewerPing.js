// Live viewer count. Owncast (v0.2.5) counts a viewer per ping to /api/ping:
// its own player pings every 4 s while playing and a viewer expires 15 s after
// its last ping. The site plays the HLS feed with its own player (same origin
// /hls/), so without these pings Owncast counted almost nobody (~5 viewers for
// a class of 60). nginx forwards /live-stream-ping/ to Owncast's /api/ping
// behind the same stream authorization as the video, and sends ?viewer=<tag>
// as the viewer's address so every student counts once.

export const OWNCAST_PING_INTERVAL_MS = 4000;
export const OWNCAST_PING_PATH = "/live-stream-ping/";

/** "u<id>" for a signed-in student, else a random tag for this player. */
export function owncastViewerTag(userId, random = Math.random) {
  const id = Number(userId || 0);
  if (Number.isInteger(id) && id > 0) return `u${id}`;
  return `t${Math.floor(random() * 1e12).toString(36)}`;
}

/** The ping URL next to the HLS playlist (same origin), or "" if unknown. */
export function owncastPingUrl(hlsUrl, viewerTag, base = typeof window !== "undefined" ? window.location.href : "") {
  if (!hlsUrl) return "";
  try {
    const url = new URL(OWNCAST_PING_PATH, new URL(hlsUrl, base || undefined));
    if (/^[A-Za-z0-9-]{1,48}$/.test(String(viewerTag || ""))) url.searchParams.set("viewer", viewerTag);
    return url.toString();
  } catch {
    return "";
  }
}

/** Counts as watching: playing frames right now (like Owncast's own player). */
export function isVideoPlaying(video) {
  return Boolean(video) && !video.paused && !video.ended && Number(video.readyState || 0) >= 2;
}

/** Fire-and-forget ping; a failed ping only means this tick is not counted. */
export function sendOwncastPing(url, fetchImpl = typeof fetch === "function" ? fetch : null) {
  if (!url || !fetchImpl) return;
  try {
    const pending = fetchImpl(url, { method: "GET", credentials: "include", cache: "no-store", keepalive: true });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Ping while ``getVideo()`` is playing; returns a stop function.
 * Pings at once when playback starts so a viewer counts within seconds.
 */
export function startOwncastViewerPing({ url, getVideo, interval = OWNCAST_PING_INTERVAL_MS, send = sendOwncastPing }) {
  if (!url || typeof getVideo !== "function") return () => {};
  const tick = () => {
    if (isVideoPlaying(getVideo())) send(url);
  };
  const timer = setInterval(tick, interval);
  const video = getVideo();
  const onPlaying = () => send(url);
  video?.addEventListener?.("playing", onPlaying);
  tick();
  return () => {
    clearInterval(timer);
    video?.removeEventListener?.("playing", onPlaying);
  };
}
