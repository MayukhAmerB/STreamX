import apiClient from "../../api/client";
import { resolveApiBaseUrl } from "../../utils/backendUrl";

// Weekly reports API (see contracts/openapi.yaml, tag "reports").
// Students: /reports/tasks/…, graders: /reports/manage/…

/** Absolute/relative href for a GET the browser opens itself (download, iframe, img). */
export function reportsHref(path, params) {
  const query = params ? new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")).toString() : "";
  return `${resolveApiBaseUrl()}${path}${query ? `?${query}` : ""}`;
}

export const submissionFilePath = (fileId) => `/reports/files/${fileId}/download/`;
export const attachmentFilePath = (attachmentId) => `/reports/attachments/${attachmentId}/download/`;
export const feedbackFilePath = (submissionId) => `/reports/feedback-files/${submissionId}/download/`;

/** The API path of a file shown by the previews ({ source, id, submissionId }). */
export function reportFilePath(file) {
  if (file?.source === "attachment") return attachmentFilePath(file.id);
  if (file?.source === "feedback") return feedbackFilePath(file.submissionId);
  return submissionFilePath(file?.id);
}

/** Text content of a previewable file (Markdown, canvas). */
export const fetchReportFileText = (file) =>
  apiClient.get(reportFilePath(file), { responseType: "text", transformResponse: [(data) => data] });

// --- Students ---------------------------------------------------------------
export const listReportTasks = (params = {}) => apiClient.get("/reports/tasks/", { params });
export const getReportTask = (taskId) => apiClient.get(`/reports/tasks/${taskId}/`);
export const getMyMarks = () => apiClient.get("/reports/marks/");

export function uploadReportFile(taskId, file, { onProgress, signal } = {}) {
  const form = new FormData();
  form.append("file", file);
  return apiClient.post(`/reports/tasks/${taskId}/uploads/`, form, {
    signal,
    onUploadProgress: (event) => {
      if (onProgress && event?.total) onProgress(Math.min(1, event.loaded / event.total));
    },
  });
}

export const removeReportUpload = (taskId, fileId) => apiClient.delete(`/reports/tasks/${taskId}/uploads/${fileId}/`);

/** Idempotent: the same key replays the first answer, so a double tap never submits twice. */
export const submitReport = (taskId, { fileIds, note }, idempotencyKey) =>
  apiClient.post(
    `/reports/tasks/${taskId}/submit/`,
    { file_ids: fileIds, note: note || "" },
    { headers: { "Idempotency-Key": idempotencyKey } }
  );

// --- Graders ----------------------------------------------------------------
export const listGradableCourses = () => apiClient.get("/reports/manage/courses/");
export const listManageTasks = (params = {}) => apiClient.get("/reports/manage/tasks/", { params });
export const getManageTask = (taskId) => apiClient.get(`/reports/manage/tasks/${taskId}/`);
export const createManageTask = (payload) => apiClient.post("/reports/manage/tasks/", payload);
export const updateManageTask = (taskId, payload) => apiClient.patch(`/reports/manage/tasks/${taskId}/`, payload);
export const deleteManageTask = (taskId) => apiClient.delete(`/reports/manage/tasks/${taskId}/`);
export const publishTask = (taskId) => apiClient.post(`/reports/manage/tasks/${taskId}/publish/`);
export const closeTask = (taskId) => apiClient.post(`/reports/manage/tasks/${taskId}/close/`);
export const reopenTask = (taskId) => apiClient.post(`/reports/manage/tasks/${taskId}/reopen/`);
export const releaseMarks = (taskId) => apiClient.post(`/reports/manage/tasks/${taskId}/release-marks/`);
export const duplicateTask = (taskId) => apiClient.post(`/reports/manage/tasks/${taskId}/duplicate/`);

export function uploadTaskAttachment(taskId, file) {
  const form = new FormData();
  form.append("file", file);
  return apiClient.post(`/reports/manage/tasks/${taskId}/attachments/`, form);
}

export const deleteTaskAttachment = (attachmentId) => apiClient.delete(`/reports/manage/attachments/${attachmentId}/`);

export const listSubmissions = (params = {}) => apiClient.get("/reports/manage/submissions/", { params });
export const getSubmission = (submissionId, params = {}) =>
  apiClient.get(`/reports/manage/submissions/${submissionId}/`, { params });

/** JSON, or multipart when an annotated file is attached. */
export function gradeSubmission(submissionId, payload, params = {}) {
  const { annotatedFile, ...fields } = payload;
  if (!annotatedFile) {
    return apiClient.post(`/reports/manage/submissions/${submissionId}/grade/`, fields, { params });
  }
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  });
  form.append("annotated_file", annotatedFile);
  return apiClient.post(`/reports/manage/submissions/${submissionId}/grade/`, form, { params });
}

export const getGradebook = (courseId) => apiClient.get("/reports/manage/gradebook/", { params: { course: courseId } });

export const marksExportHref = (params) => reportsHref("/reports/manage/export.csv", params);
export const taskZipHref = (taskId) => reportsHref(`/reports/manage/tasks/${taskId}/download.zip`);

/** A random key per logical submit (crypto.randomUUID where available). */
export function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
