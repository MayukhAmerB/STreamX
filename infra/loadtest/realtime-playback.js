import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const API_BASE_URL = (__ENV.API_BASE_URL || "https://api.alsyedinitiative.com").replace(/\/$/, "");
const WEB_BASE_URL = (__ENV.WEB_BASE_URL || "https://alsyedinitiative.com").replace(/\/$/, "");
const SESSION_ID = String(__ENV.SESSION_ID || "").trim();
const AUTH_TOKEN = String(__ENV.AUTH_TOKEN || "").trim();
const AUTH_TOKENS_ENV = __ENV.AUTH_TOKENS || "";
const AUTH_TOKENS_FILE = __ENV.AUTH_TOKENS_FILE || "";
const VUS = Number(__ENV.VUS || 100);
const POLL_SECONDS = Number(__ENV.POLL_SECONDS || 3);
const SEGMENTS_PER_POLL = Number(__ENV.SEGMENTS_PER_POLL || 3);
const DEBUG_ERRORS = parseBoolean(__ENV.DEBUG_ERRORS || "false");

const playbackFailures = new Rate("streamx_playback_failures");
const manifestDuration = new Trend("streamx_manifest_duration", true);
const segmentDuration = new Trend("streamx_segment_duration", true);
const fetchedSegments = new Set();

if (!SESSION_ID) throw new Error("SESSION_ID is required.");

const AUTH_TOKENS = loadAuthTokens();
if (!AUTH_TOKENS.length) {
  throw new Error("Set AUTH_TOKEN, AUTH_TOKENS, or AUTH_TOKENS_FILE.");
}
if (AUTH_TOKENS.length < VUS) {
  console.warn(
    `[playback] ${AUTH_TOKENS.length} token(s) configured for ${VUS} VUs. ` +
      "Use one authorized token per viewer for a representative test.",
  );
}

export const options = {
  scenarios: {
    viewers: {
      executor: "constant-vus",
      vus: VUS,
      duration: __ENV.DURATION || "15m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    streamx_playback_failures: ["rate<0.01"],
    streamx_manifest_duration: ["p(95)<3000"],
    streamx_segment_duration: ["p(95)<5000"],
  },
};

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function splitTokens(rawValue) {
  return String(rawValue || "")
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadAuthTokens() {
  const tokens = [];
  if (AUTH_TOKEN) tokens.push(AUTH_TOKEN);
  tokens.push(...splitTokens(AUTH_TOKENS_ENV));
  if (AUTH_TOKENS_FILE) tokens.push(...splitTokens(open(AUTH_TOKENS_FILE)));
  return tokens;
}

function tokenForViewer() {
  return AUTH_TOKENS[(Math.max(1, __VU) - 1) % AUTH_TOKENS.length];
}

function absoluteUrl(baseUrl, candidate) {
  const value = String(candidate || "").trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${baseUrl}${value}`;
  const parent = baseUrl.replace(/\/[^/]*$/, "");
  return `${parent}/${value}`;
}

function responseJson(response) {
  try {
    return response.json();
  } catch (_error) {
    return null;
  }
}

function logFailure(stage, response) {
  if (!DEBUG_ERRORS) return;
  const preview = String(response?.body || "").trim().slice(0, 240);
  console.error(
    `[${stage}] vu=${__VU} iter=${__ITER} status=${response?.status || 0} ` +
      `url=${response?.url || "unknown"} body=${JSON.stringify(preview)}`,
  );
}

function playlistEntries(body) {
  return String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isMediaSegment(value) {
  return /\.(?:ts|m4s|mp4|aac)(?:\?|$)/i.test(value);
}

function prepareViewer() {
  const launch = http.post(
    `${API_BASE_URL}/api/realtime/sessions/${SESSION_ID}/broadcast-stream/launch/`,
    "{}",
    {
      headers: {
        Authorization: `Bearer ${tokenForViewer()}`,
        "Content-Type": "application/json",
      },
      tags: { name: "broadcast_stream_launch" },
    },
  );
  const payload = responseJson(launch);
  const launchSucceeded = Boolean(
    launch.status === 200 && payload?.success === true && payload?.data?.same_origin_launch_url,
  );
  check(launch, { "stream launch authorized": () => launchSucceeded });
  if (!launchSucceeded) {
    playbackFailures.add(true);
    logFailure("launch", launch);
    return "";
  }

  const bootstrapUrl = absoluteUrl(WEB_BASE_URL, payload.data.same_origin_launch_url);
  const bootstrap = http.get(bootstrapUrl, {
    redirects: 5,
    tags: { name: "stream_cookie_bootstrap" },
  });
  const bootstrapSucceeded = bootstrap.status >= 200 && bootstrap.status < 400;
  check(bootstrap, { "stream cookie prepared": () => bootstrapSucceeded });
  if (!bootstrapSucceeded) {
    playbackFailures.add(true);
    logFailure("bootstrap", bootstrap);
    return "";
  }

  return absoluteUrl(WEB_BASE_URL, payload.data.same_origin_hls_url || "/hls/stream.m3u8");
}

function fetchMediaPlaylist(manifestUrl) {
  const manifest = http.get(manifestUrl, {
    tags: { name: "hls_manifest" },
    timeout: "30s",
  });
  manifestDuration.add(manifest.timings.duration);
  const manifestSucceeded = manifest.status === 200 && String(manifest.body || "").includes("#EXTM3U");
  check(manifest, { "HLS manifest loaded": () => manifestSucceeded });
  if (!manifestSucceeded) {
    playbackFailures.add(true);
    logFailure("manifest", manifest);
    return null;
  }

  const entries = playlistEntries(manifest.body);
  const hasSegments = entries.some(isMediaSegment);
  if (hasSegments) return { url: manifestUrl, body: manifest.body };

  const variant = entries[0];
  if (!variant) {
    playbackFailures.add(true);
    return null;
  }

  const variantUrl = absoluteUrl(manifestUrl, variant);
  const variantResponse = http.get(variantUrl, {
    tags: { name: "hls_variant_playlist" },
    timeout: "30s",
  });
  manifestDuration.add(variantResponse.timings.duration);
  const variantSucceeded =
    variantResponse.status === 200 && String(variantResponse.body || "").includes("#EXTM3U");
  check(variantResponse, { "HLS variant loaded": () => variantSucceeded });
  if (!variantSucceeded) {
    playbackFailures.add(true);
    logFailure("variant", variantResponse);
    return null;
  }
  return { url: variantUrl, body: variantResponse.body };
}

function fetchNewestSegments(playlist) {
  const segmentUrls = playlistEntries(playlist.body)
    .filter(isMediaSegment)
    .map((entry) => absoluteUrl(playlist.url, entry));
  const unseen = segmentUrls
    .filter((url) => !fetchedSegments.has(url))
    .slice(-Math.max(1, SEGMENTS_PER_POLL));

  for (const url of unseen) {
    const response = http.get(url, {
      tags: { name: "hls_media_segment" },
      timeout: "120s",
      responseType: "binary",
    });
    segmentDuration.add(response.timings.duration);
    const segmentSucceeded = response.status === 200 && Number(response.body?.byteLength || 0) > 0;
    check(response, { "HLS media segment loaded": () => segmentSucceeded });
    playbackFailures.add(!segmentSucceeded);
    if (segmentSucceeded) fetchedSegments.add(url);
    else logFailure("segment", response);
  }

  if (fetchedSegments.size > 500) fetchedSegments.clear();
}

export default function () {
  const manifestUrl = prepareViewer();
  if (!manifestUrl) {
    sleep(POLL_SECONDS);
    return;
  }

  while (true) {
    const playlist = fetchMediaPlaylist(manifestUrl);
    if (playlist) fetchNewestSegments(playlist);
    sleep(POLL_SECONDS);
  }
}
