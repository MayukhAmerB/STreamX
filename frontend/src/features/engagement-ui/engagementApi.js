// Engagement API client (XP, levels, streaks, badges, leaderboards,
// achievements). OWNER: WS-LEARN (console-student). Contract:
// scratchpad/engagement-notes.md §9 + shapes.json.
//
// Every read sends `If-None-Match` when we hold an ETag; a 304 answers
// "unchanged" and costs the server one indexed read. A 403 `feature_disabled`
// means the `engagement` switch is off: callers hide the engagement UI.
import apiClient from "../../api/client";

const notModifiedOk = (status) => (status >= 200 && status < 300) || status === 304;

/** GET with an optional ETag. Resolves `{ status, etag, data }` (data null on 304). */
async function conditionalGet(url, { etag = "", params } = {}) {
  const response = await apiClient.get(url, {
    params,
    headers: etag ? { "If-None-Match": etag } : undefined,
    validateStatus: notModifiedOk,
  });
  const status = Number(response?.status) || 200;
  return {
    status,
    etag: String(response?.headers?.etag || "") || etag,
    data: status === 304 ? null : response?.data?.data ?? null,
  };
}

export const fetchEngagementMe = (options) => conditionalGet("/engagement/me/", options);

/** `period`: "week" | "all"; `batch`: a course id the viewer is enrolled in (optional). */
export const fetchLeaderboard = ({ period = "week", batch = null, etag = "" } = {}) =>
  conditionalGet("/engagement/leaderboard/", {
    etag,
    params: { scope: "batch", period, ...(batch ? { batch } : {}) },
  });

export const fetchBadgeCatalogue = (options) => conditionalGet("/engagement/badges/", options);

/** The level chart: every rank, its threshold and unlocks, how to earn XP, and `me`. */
export const fetchLevelChart = (options) => conditionalGet("/engagement/levels/", options);

/** The level-up moment was shown: acknowledge it so it is shown once. */
export const acknowledgeLevelUp = () => apiClient.post("/engagement/me/level-seen/", {});

export const fetchMyAchievements = (options) => conditionalGet("/engagement/achievements/", options);

/** "Your journey so far" (legacy students, once): `{ show, journey }`. */
export const fetchJourney = () => apiClient.get("/engagement/journey/").then((response) => response?.data?.data ?? null);

/** The journey welcome was closed: the server remembers it (shown once). */
export const dismissJourney = () => apiClient.post("/engagement/journey/dismiss/", {});

export const fetchEngagementSettings = () => apiClient.get("/engagement/settings/");

/** `{ leaderboard_display: "handle" | "hidden" }` (handle only: owner privacy rule) */
export const saveEngagementSettings = (patch) => apiClient.patch("/engagement/settings/", patch);

/** Public verification (no sign-in needed). */
export const fetchPublicAchievement = (slug) => apiClient.get(`/engagement/achievements/${encodeURIComponent(slug)}/`);

/** Live presence: once a minute while a live class page is open and visible. */
export const postLivePresence = (sessionId) => apiClient.post(`/engagement/live/${encodeURIComponent(sessionId)}/presence/`, {});

/** True when an axios error is the `engagement` switch answering 403 feature_disabled. */
export function isEngagementDisabledError(error) {
  const response = error?.response;
  if (response?.status !== 403) return false;
  const data = response.data || {};
  return (data.code || data.errors?.code) === "feature_disabled";
}

/**
 * Parses the `X-Engagement` response header (sent by a request that queued an
 * XP-earning event): `{ pending_xp, xp, level, streak, version }` or null.
 */
export function parseEngagementHeader(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== "object") return null;
    return {
      pendingXp: Math.max(0, Number(parsed.pending_xp) || 0),
      xp: Number.isFinite(Number(parsed.xp)) ? Number(parsed.xp) : null,
      level: parsed.level && typeof parsed.level === "object" ? parsed.level : null,
      streak: parsed.streak && typeof parsed.streak === "object" ? parsed.streak : null,
      version: Number(parsed.version) || 0,
    };
  } catch {
    return null;
  }
}

let headerInterceptor = null;

/**
 * Listens to every API answer for `X-Engagement` (registered once, on first
 * use of the engagement store). The header is same-origin and exposed through
 * CORS by the backend.
 */
export function watchEngagementHeader(onHeader) {
  if (headerInterceptor !== null || !apiClient?.interceptors?.response) return;
  headerInterceptor = apiClient.interceptors.response.use((response) => {
    const raw = response?.headers?.["x-engagement"];
    if (raw) {
      const parsed = parseEngagementHeader(raw);
      if (parsed) onHeader(parsed);
    }
    return response;
  });
}

/** Test helper. */
export function resetEngagementHeaderWatch() {
  if (headerInterceptor !== null && apiClient?.interceptors?.response) {
    apiClient.interceptors.response.eject(headerInterceptor);
  }
  headerInterceptor = null;
}
