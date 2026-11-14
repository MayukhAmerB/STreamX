// Class calendar API client. OWNER: WS-ATTENDANCE (calendar).
// Contract: scratchpad/attendance-notes.md ("API shapes").
import apiClient from "../../api/client";

const data = (response) => response?.data?.data ?? null;

function clean(params) {
  return Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

/** `{ from, to }` ISO dates (India time) → `{ events, from, to, timezone }`. */
export const fetchMyEvents = (params) => apiClient.get("/calendar/me/events/", { params: clean(params) }).then(data);

export const fetchMyFeed = () => apiClient.get("/calendar/me/feed/").then(data);
/** Creates the link, or replaces it (older links stop working). */
export const createMyFeed = () => apiClient.post("/calendar/me/feed/", {}).then(data);
export const revokeMyFeed = () => apiClient.delete("/calendar/me/feed/").then(data);

/** Public: upcoming live classes for the landing page (no sign-in). */
export const fetchPublicUpcoming = (limit = 6) => apiClient.get("/calendar/public/upcoming/", { params: { limit } }).then(data);

// --- staff -------------------------------------------------------------------------------
export const fetchStaffEvents = (params) => apiClient.get("/calendar/staff/events/", { params: clean(params) }).then(data);
export const fetchStaffOptions = () => apiClient.get("/calendar/staff/options/").then(data);
export const fetchSchedules = (params) => apiClient.get("/calendar/staff/schedules/", { params: clean(params) }).then(data);
export const fetchSchedule = (id) => apiClient.get(`/calendar/staff/schedules/${encodeURIComponent(id)}/`).then(data);
export const previewSchedule = (body) => apiClient.post("/calendar/staff/schedules/preview/", body).then(data);
export const createSchedule = (body) => apiClient.post("/calendar/staff/schedules/", body).then(data);
export const updateSchedule = (id, body) => apiClient.patch(`/calendar/staff/schedules/${encodeURIComponent(id)}/`, body).then(data);
export const pauseSchedule = (id) => apiClient.delete(`/calendar/staff/schedules/${encodeURIComponent(id)}/`).then(data);
/** `{ kind: cancelled|rescheduled|extra, date, new_start, duration_minutes, title, note }` */
export const addScheduleException = (id, body) =>
  apiClient.post(`/calendar/staff/schedules/${encodeURIComponent(id)}/exceptions/`, body).then(data);
export const removeScheduleException = (exceptionId) =>
  apiClient.delete(`/calendar/staff/exceptions/${encodeURIComponent(exceptionId)}/`).then(data);
