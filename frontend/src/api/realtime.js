import apiClient from "./client";
import { dedupedGet } from "./requestDedup";

export const listRealtimeSessions = (params = {}) =>
  dedupedGet("/realtime/sessions/", params, () => apiClient.get("/realtime/sessions/", { params }));
export const getRealtimeSession = (id) =>
  dedupedGet(`/realtime/sessions/${id}/`, {}, () => apiClient.get(`/realtime/sessions/${id}/`));
export const createRealtimeSession = (payload) => apiClient.post("/realtime/sessions/", payload);
export const joinRealtimeSession = (id, payload = {}) => apiClient.post(`/realtime/sessions/${id}/join/`, payload);
export const endRealtimeSession = (id) => apiClient.post(`/realtime/sessions/${id}/end/`);
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
