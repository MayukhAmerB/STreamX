import apiClient from "./client";
import { dedupedGet } from "./requestDedup";
import { getRealtimeDeviceId } from "../services/realtime/deviceId";
import { apiData } from "../utils/api";

export const listRealtimeSessions = (params = {}) =>
  dedupedGet("/realtime/sessions/", params, () => apiClient.get("/realtime/sessions/", { params }));
// Conditional list poll: an unchanged list answers 304 (no body); the caller
// keeps its copy. Used by the shared live-sessions store.
export const listRealtimeSessionsConditional = (params = {}, etag = "") =>
  apiClient.get("/realtime/sessions/", {
    params,
    headers: etag ? { "If-None-Match": etag } : undefined,
    validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
  });
export const getRealtimeSession = (id) =>
  dedupedGet(`/realtime/sessions/${id}/`, {}, () => apiClient.get(`/realtime/sessions/${id}/`));
export const createRealtimeSession = (payload) => apiClient.post("/realtime/sessions/", payload);
// device_id keeps the meeting identity stable across rejoins (Phase 2, D9).
export const joinRealtimeSession = (id, payload = {}) =>
  apiClient.post(
    `/realtime/sessions/${id}/join/`,
    { device_id: getRealtimeDeviceId(), ...payload },
    { timeout: 20000 }
  );
export const reportRealtimeConnectionEvent = (id, payload) =>
  apiClient.post(`/realtime/sessions/${id}/connection-events/`, payload, { timeout: 5000 });
export const createRealtimeOwncastStreamLaunch = (id) =>
  apiClient.post(`/realtime/sessions/${id}/broadcast-stream/launch/`);
export const reportRealtimeBroadcastPlaybackIssue = (id, payload) =>
  apiClient.post(`/realtime/sessions/${id}/broadcast-playback/issues/`, payload);
export const createRealtimeOwncastChatLaunch = (id) =>
  apiClient.post(`/realtime/sessions/${id}/broadcast-chat/launch/`);
export const getRealtimeOwncastChatModeration = (id) =>
  apiClient.get(`/realtime/sessions/${id}/broadcast-chat/moderation/`);
export const applyRealtimeOwncastChatModeration = (id, payload) =>
  apiClient.post(`/realtime/sessions/${id}/broadcast-chat/moderation/`, payload);
export const endRealtimeSession = (id) => apiClient.post(`/realtime/sessions/${id}/end/`);
// Topic, description and module the class's recording is published with.
export const saveRealtimeClassDetails = (id, payload) =>
  apiClient.post(`/realtime/sessions/${id}/class-details/`, payload);
export const getRealtimeHostToken = (id) => apiClient.post(`/realtime/sessions/${id}/host-token/`);
export const startRealtimeStream = (id) => apiClient.post(`/realtime/sessions/${id}/stream/start/`);
export const stopRealtimeStream = (id) => apiClient.post(`/realtime/sessions/${id}/stream/stop/`);
export const rotateRealtimeStreamKey = (id) => apiClient.post(`/realtime/sessions/${id}/stream/rotate-key/`);
export const listRealtimeRecordings = (id) => apiClient.get(`/realtime/sessions/${id}/recordings/`);
export const startRealtimeRecording = (id) => apiClient.post(`/realtime/sessions/${id}/recordings/start/`);
export const stopRealtimeRecording = (id) => apiClient.post(`/realtime/sessions/${id}/recordings/stop/`);
export const deleteRealtimeRecording = (recordingId) => apiClient.delete(`/realtime/recordings/${recordingId}/`);
export const uploadRealtimeBrowserRecording = (id, formData) =>
  apiClient.post(`/realtime/sessions/${id}/recordings/browser-upload/`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
export const grantRealtimePresenter = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/presenters/grant/`, { user_id: userId });
export const revokeRealtimePresenter = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/presenters/revoke/`, { user_id: userId });
export const grantRealtimeSpeaker = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/speakers/grant/`, { user_id: userId });
export const revokeRealtimeSpeaker = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/speakers/revoke/`, { user_id: userId });

// --- Phase 2: live-class lifecycle ---
// Async Go Live: POST answers 202 {state: "starting"}; poll GET until "live" or "failed".
export const goLiveRealtimeStream = async (id) =>
  apiData(await apiClient.post(`/realtime/sessions/${id}/go-live/`, {}, { timeout: 15000 }), null);
export const getRealtimeGoLiveStatus = async (id) =>
  apiData(await apiClient.get(`/realtime/sessions/${id}/go-live/`, { timeout: 10000 }), null);
// Pre-class readiness probe (instructors and admins).
export const getRealtimePreflight = async ({ refresh = false } = {}) =>
  apiData(await apiClient.get("/realtime/preflight/", { params: refresh ? { refresh: 1 } : {} }), {})?.preflight || null;
