// Attendance API client. OWNER: WS-ATTENDANCE.
// Contract: scratchpad/attendance-notes.md ("API shapes"). Every call answers
// 403 `feature_disabled` while the `attendance` switch is off.
import apiClient, { featureDisabledDetail } from "../../api/client";

const data = (response) => response?.data?.data ?? null;

/** Live presence: once a minute while a live class page is open and visible. */
export const postPresence = (sessionId) =>
  apiClient.post(`/attendance/sessions/${encodeURIComponent(sessionId)}/presence/`, {}).then(data);

/** Leaving the live page stops the attendance clock (best effort). */
export const postLeave = (sessionId) =>
  apiClient.post(`/attendance/sessions/${encodeURIComponent(sessionId)}/leave/`, {}).then(data);

export const fetchMySummary = () => apiClient.get("/attendance/me/summary/").then(data);

/** `{ course, status, page, page_size }` → `{ results, pagination }` */
export const fetchMyClasses = (params = {}) => apiClient.get("/attendance/me/classes/", { params: clean(params) }).then(data);

// --- staff / instructors ---------------------------------------------------------------
export const fetchStaffCourses = () => apiClient.get("/attendance/staff/courses/").then(data);
export const fetchStaffSessions = (params = {}) =>
  apiClient.get("/attendance/staff/sessions/", { params: clean(params) }).then(data);
export const fetchRoster = (sessionId) =>
  apiClient.get(`/attendance/staff/sessions/${encodeURIComponent(sessionId)}/roster/`).then(data);
/** `{ user_id, status: present|partial|absent|excused|auto, reason }` */
export const overrideAttendance = (sessionId, body) =>
  apiClient.post(`/attendance/staff/sessions/${encodeURIComponent(sessionId)}/override/`, body).then(data);
export const fetchMatrix = (params = {}) => apiClient.get("/attendance/staff/matrix/", { params: clean(params) }).then(data);
export const fetchLowAttendance = (params = {}) =>
  apiClient.get("/attendance/staff/low-attendance/", { params: clean(params) }).then(data);
export const fetchPolicy = () => apiClient.get("/attendance/staff/policy/").then(data);

/** CSV export: `kind` = roster | matrix | low; downloads through the authenticated client. */
export async function downloadCsv(kind, { sessionId, params = {}, filename = "attendance.csv" } = {}) {
  const url =
    kind === "roster"
      ? `/attendance/staff/sessions/${encodeURIComponent(sessionId)}/roster/`
      : kind === "matrix"
        ? "/attendance/staff/matrix/"
        : "/attendance/staff/low-attendance/";
  const response = await apiClient.get(url, { params: { ...clean(params), export: "csv" }, responseType: "blob" });
  saveBlob(response.data, filename);
}

export function saveBlob(blob, filename) {
  if (typeof window === "undefined" || !window.URL?.createObjectURL) return;
  const href = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(href), 1000);
}

/** True when `error` is the `attendance` switch answering 403 feature_disabled. */
export function isAttendanceDisabledError(error) {
  const detail = featureDisabledDetail(error);
  if (detail) return !detail.feature || detail.feature === "attendance";
  const response = error?.response;
  return response?.status === 403 && (response.data?.code || response.data?.errors?.code) === "feature_disabled";
}

/** A short, user-facing message for a failed call. */
export function errorMessage(error, fallback = "Something went wrong. Try again.") {
  const payload = error?.response?.data;
  return payload?.message || payload?.detail || payload?.errors?.detail || fallback;
}

function clean(params) {
  return Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}
