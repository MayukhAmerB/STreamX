// Reward history + highlights client. Contract: scratchpad/hybrid/rewards-api.md
// (GET /engagement/me/history/, PATCH /engagement/me/highlights/).
import apiClient from "../../api/client";
import { resolveApiBaseUrl } from "../../utils/backendUrl";

const data = (response) => response?.data?.data ?? null;

export const MAX_HIGHLIGHTS = 3;

/** `{ summary, xp: {items,page,page_size,total,has_more}, badges, batches, certificates, highlights }` */
export const fetchRewardHistory = ({ page = 1, pageSize = 25 } = {}) =>
  apiClient.get("/engagement/me/history/", { params: { page, page_size: pageSize } }).then(data);

/** `{ badges?: string[], certificates?: string[] }` → `{ badges, certificates, max }`. */
export const saveHighlights = (patch) => apiClient.patch("/engagement/me/highlights/", patch).then(data);

/** Owner-only download (the server answers 404 to anyone else). */
export const certificatePdfUrl = (reference) =>
  `${resolveApiBaseUrl()}/engagement/certificates/${encodeURIComponent(String(reference || ""))}/certificate.pdf`;

/** The SPA certificate page (full certificate for the owner only). */
export const certificatePageUrl = (certificate) =>
  certificate?.url || `/certificates/${encodeURIComponent(String(certificate?.reference || ""))}`;

/** The first field message of a 400 `validation_failed`, else the API message. */
export function highlightError(error) {
  const body = error?.response?.data || {};
  const errors = body.errors || {};
  for (const key of ["highlights", "badges", "certificates"]) {
    const value = errors[key];
    if (Array.isArray(value) && value.length) return String(value[0]);
    if (typeof value === "string" && value) return value;
  }
  return body.message || "Could not save your highlights. Try again.";
}

/**
 * The highlights after toggling one item, or `{ error }` when the cap is hit.
 * `kind`: "badge" | "certificate"; `id`: badge key or certificate reference.
 */
export function toggleHighlight(highlights, kind, id) {
  const current = {
    badges: [...(highlights?.badges || [])],
    certificates: [...(highlights?.certificates || [])],
  };
  const listKey = kind === "certificate" ? "certificates" : "badges";
  const list = current[listKey];
  if (list.includes(id)) {
    current[listKey] = list.filter((item) => item !== id);
    return { next: current };
  }
  const max = Number(highlights?.max) || MAX_HIGHLIGHTS;
  if (current.badges.length + current.certificates.length >= max) {
    return { error: `You can highlight up to ${max} items. Remove one first.` };
  }
  current[listKey] = [...list, id];
  return { next: current };
}
