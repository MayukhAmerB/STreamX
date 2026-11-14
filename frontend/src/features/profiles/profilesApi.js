// Student profiles API client (/api/profiles/). OWNER: WS-PROFILES.
// A 403 `feature_disabled` means the `public_profiles` switch is off: the
// pages show "coming soon" (the shared client also refreshes capabilities).
import apiClient from "../../api/client";

const data = (response) => response?.data?.data ?? null;

export const fetchMyProfile = () => apiClient.get("/profiles/me/").then(data);

/** `document` is the whole editable document; `draftVersion` guards against a stale tab (409). */
export const saveDraft = (document, draftVersion) =>
  apiClient.put("/profiles/me/draft/", { document, draft_version: draftVersion }).then(data);

export const publishProfile = () => apiClient.post("/profiles/me/publish/", {}).then(data);

export const unpublishProfile = () => apiClient.post("/profiles/me/unpublish/", {}).then(data);

/** `{ visibility?: "public" | "members", show_real_name?: bool, show_on_leaderboards?: bool }` */
export const saveProfileSettings = (patch) => apiClient.patch("/profiles/me/settings/", patch).then(data);

export const changeHandle = (handle) => apiClient.post("/profiles/me/handle/", { handle }).then(data);

export const fetchPreview = () => apiClient.get("/profiles/me/preview/").then(data);

/** `kind`: "avatar" | "banner" | "gallery". */
export function uploadProfileImage(file, kind) {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", kind);
  return apiClient.post("/profiles/me/images/", form).then(data);
}

export const deleteProfileImage = (id) => apiClient.delete(`/profiles/me/images/${encodeURIComponent(id)}/`).then(data);

export const fetchPublicProfile = (handle) => apiClient.get(`/profiles/u/${encodeURIComponent(handle)}/`).then(data);

/** `reason`: personal_info | harassment | impersonation | inappropriate | spam | other. */
export const reportProfile = (handle, reason, details = "") =>
  apiClient.post(`/profiles/u/${encodeURIComponent(handle)}/report/`, { reason, details }).then(data);

/**
 * Profile images are private files served after a permission check
 * (`/api/profiles/media/<id>/`), so they are fetched with the session and
 * shown from an object URL. Resolves a `blob:` URL (the caller revokes it).
 */
export async function fetchProfileImageUrl(src) {
  const path = String(src || "").replace(/^\/api(?=\/)/, "");
  if (!/^\/profiles\/media\/[0-9a-f-]{36}\/$/i.test(path)) throw new Error("not a profile image");
  const response = await apiClient.get(path, { responseType: "blob" });
  return URL.createObjectURL(response.data);
}

/** The API error as `{ status, code, message, details }`. */
export function readError(error) {
  const response = error?.response;
  const body = response?.data || {};
  return {
    status: response?.status || 0,
    code: body.code || body.errors?.code || "",
    message: body.message || body.detail || body.errors?.detail || "Something went wrong. Try again.",
    details: body.errors || {},
  };
}

/** The student keeps the automatic handle: the one-time "customise your handle" prompt is not shown again. */
export const dismissHandlePrompt = () => apiClient.post("/profiles/me/handle/prompt/dismiss/", {}).then(data);
