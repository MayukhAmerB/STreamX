// Monthly OSINT CTF API client (`/api/ctf/seasons/*`). OWNER: WS-MONTHLY-CTF.
//
// Every endpoint except certificate verification answers 403
// `feature_disabled` while the `monthly_ctf` switch is off; callers show the
// calm "opens soon" state instead of an error (never hide the section).
import apiClient from "../../api/client";
import { apiData } from "../../utils/api";

const unwrap = (response) => apiData(response, null);
const enc = encodeURIComponent;

export const fetchCurrentSeason = () => apiClient.get("/ctf/seasons/current/").then(unwrap);

export const fetchSeason = (slug) => apiClient.get(`/ctf/seasons/${enc(slug)}/`).then(unwrap);

/**
 * The board is sent with `Cache-Control: private, max-age=15`. `fresh` adds a
 * one-off query value so a refetch right after the viewer's own answer never
 * shows the browser's cached copy.
 */
export const fetchSeasonLeaderboard = (slug, { limit = 25, fresh = false } = {}) =>
  apiClient
    .get(`/ctf/seasons/${enc(slug)}/leaderboard/`, { params: fresh ? { limit, t: Date.now() } : { limit } })
    .then(unwrap);

/** Resolves `{ message, data }` so the page can announce the server's sentence. */
export const submitSeasonAnswer = (slug, answer) =>
  apiClient.post(`/ctf/seasons/${enc(slug)}/submit/`, { answer }).then((response) => ({
    message: String(response?.data?.message || ""),
    data: unwrap(response),
  }));

/** `fresh`: bypass the browser's 30 s copy (the play page reads it on open, right after results may have landed). */
export const fetchMySeasonSummary = ({ fresh = false } = {}) =>
  apiClient.get("/ctf/seasons/me/", fresh ? { params: { t: Date.now() } } : undefined).then(unwrap);

/** `{ users: { "<id>": { aura, frame, frame_tier, title, until } } }` (at most 100 ids). */
export const fetchCosmetics = (userIds = []) =>
  apiClient.get("/ctf/seasons/cosmetics/", { params: { user_ids: userIds.slice(0, 100).join(",") } }).then(unwrap);

export const fetchHallOfFame = () => apiClient.get("/ctf/seasons/hall-of-fame/").then(unwrap);

/** Public verification; works even while the switch is off. */
export const fetchCertificate = (slug) => apiClient.get(`/ctf/seasons/certificates/${enc(slug)}/`).then(unwrap);

/** "off" (switch off), "missing" (404), "signin" (401) or "error". */
export function seasonErrorKind(error) {
  const response = error?.response;
  const status = Number(response?.status) || 0;
  const data = response?.data || {};
  const code = data.code || data.errors?.code || data.error?.code || "";
  if (status === 403 && code === "feature_disabled") return "off";
  if (status === 404) return "missing";
  if (status === 401) return "signin";
  return "error";
}
