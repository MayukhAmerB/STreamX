// Console Admin API (``/api/admin/``). OWNER: WS-G.
import apiClient from "../../api/client";

export const fetchAttention = () => apiClient.get("/admin/attention/");
export const fetchActivity = (params = {}) => apiClient.get("/admin/activity/", { params });

export const fetchRequests = (params = {}) => apiClient.get("/admin/requests/", { params });
export const actOnRequests = (ids, action) => apiClient.post("/admin/requests/actions/", { ids, action });

export const fetchRecordings = (params = {}) => apiClient.get("/admin/recordings/", { params });
export const fetchRecording = (id) => apiClient.get(`/admin/recordings/${encodeURIComponent(id)}/`);
export const actOnRecording = (id, action) => apiClient.post(`/admin/recordings/${encodeURIComponent(id)}/actions/`, { action });

export const fetchHealth = () => apiClient.get("/admin/system/health/");
export const retryHealth = (kind, ids) => apiClient.post("/admin/system/health/retry/", ids ? { kind, ids } : { kind });

// Feature switches (WS-F's endpoints, same service as the Django page).
export const fetchFeatures = () => apiClient.get("/admin/features/");
export const setFeature = (key, body) => apiClient.post(`/admin/features/${encodeURIComponent(key)}/`, body);
