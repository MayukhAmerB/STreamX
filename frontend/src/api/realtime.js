import apiClient from "./client";

export const listRealtimeSessions = (params = {}) => apiClient.get("/realtime/sessions/", { params });
export const getRealtimeSession = (id) => apiClient.get(`/realtime/sessions/${id}/`);
export const createRealtimeSession = (payload) => apiClient.post("/realtime/sessions/", payload);
export const joinRealtimeSession = (id, payload = {}) => apiClient.post(`/realtime/sessions/${id}/join/`, payload);
export const endRealtimeSession = (id) => apiClient.post(`/realtime/sessions/${id}/end/`);
export const getRealtimeHostToken = (id) => apiClient.post(`/realtime/sessions/${id}/host-token/`);
export const startRealtimeStream = (id) => apiClient.post(`/realtime/sessions/${id}/stream/start/`);
export const stopRealtimeStream = (id) => apiClient.post(`/realtime/sessions/${id}/stream/stop/`);
export const grantRealtimePresenter = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/presenters/grant/`, { user_id: userId });
export const revokeRealtimePresenter = (id, userId) =>
  apiClient.post(`/realtime/sessions/${id}/presenters/revoke/`, { user_id: userId });
