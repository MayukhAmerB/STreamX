import apiClient from "../../api/client";

// Console -> Upload class recording: /api/recording-uploads/…
// A recording goes up in 32 MiB chunks (below Cloudflare's 100 MB body limit).

const BASE = "/recording-uploads";

export const listUploadTargets = () => apiClient.get(`${BASE}/targets/`);
export const listMyUploads = () => apiClient.get(`${BASE}/`);
export const getUpload = (id) => apiClient.get(`${BASE}/${encodeURIComponent(id)}/`);
export const abortUpload = (id) => apiClient.delete(`${BASE}/${encodeURIComponent(id)}/`);
export const completeUpload = (id) => apiClient.post(`${BASE}/${encodeURIComponent(id)}/complete/`);

/** Starts the upload, or resumes the unfinished upload of the same file (same class, name and size). */
export const createUpload = ({ sessionId, file }) =>
  apiClient.post(`${BASE}/`, {
    session_id: sessionId,
    filename: file.name,
    size: file.size,
    content_type: file.type || "",
  });

/** PUT one chunk as raw bytes. `onProgress(loadedBytes)` reports the bytes sent so far. */
export function putChunk(id, index, blob, { sha256 = "", signal, onProgress } = {}) {
  const headers = { "Content-Type": "application/octet-stream" };
  if (sha256) headers["X-Chunk-Sha256"] = sha256;
  return apiClient.put(`${BASE}/${encodeURIComponent(id)}/chunks/${index}/`, blob, {
    headers,
    signal,
    // The body is already bytes: never let axios serialise it.
    transformRequest: [(data) => data],
    onUploadProgress: (event) => onProgress?.(Number(event?.loaded) || 0),
  });
}

export const switchUploadVideo = (id, { restoreUpload = false } = {}) =>
  apiClient.post(`${BASE}/${encodeURIComponent(id)}/switch-video/`, { restore_upload: restoreUpload });

export const listUploadTokens = () => apiClient.get(`${BASE}/tokens/`);
export const createUploadToken = (name) => apiClient.post(`${BASE}/tokens/`, { name });
export const revokeUploadToken = (id) => apiClient.delete(`${BASE}/tokens/${encodeURIComponent(id)}/`);
