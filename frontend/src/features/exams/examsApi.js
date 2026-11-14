import apiClient from "../../api/client";
import { resolveApiBaseUrl } from "../../utils/backendUrl";

// Console -> Exams (staff manage, instructors read): /api/ctf-admin/…
// Student side used by the Console card: /api/ctf/eligibility/

export const listConsoleExams = () => apiClient.get("/ctf-admin/exams/");
export const getConsoleExam = (slug) => apiClient.get(`/ctf-admin/exams/${encodeURIComponent(slug)}/`);
export const updateConsoleExam = (slug, payload) => apiClient.patch(`/ctf-admin/exams/${encodeURIComponent(slug)}/`, payload);
export const publishConsoleExam = (slug) => apiClient.post(`/ctf-admin/exams/${encodeURIComponent(slug)}/publish/`);
export const unscheduleConsoleExam = (slug) => apiClient.post(`/ctf-admin/exams/${encodeURIComponent(slug)}/unschedule/`);
export const closeConsoleExam = (slug) => apiClient.post(`/ctf-admin/exams/${encodeURIComponent(slug)}/close/`);
export const getConsoleExamResults = (slug) => apiClient.get(`/ctf-admin/exams/${encodeURIComponent(slug)}/results/`);
export const listExamBatches = () => apiClient.get("/ctf-admin/batches/");
export const getExamSummary = () => apiClient.get("/ctf-admin/summary/");
export const getExamEligibility = () => apiClient.get("/ctf/eligibility/");

export const examResultsCsvHref = (slug) => `${resolveApiBaseUrl()}/ctf-admin/exams/${encodeURIComponent(slug)}/results.csv`;

function examFileForm(file, extra = {}) {
  const form = new FormData();
  form.append("file", file);
  Object.entries(extra).forEach(([key, value]) => form.append(key, String(value)));
  return form;
}

/** Dry run: validates and diffs the file; nothing is saved. */
export const previewExamFile = (file) => apiClient.post("/ctf-admin/exams/preview/", examFileForm(file));

export const uploadExamFile = (file, { allowContentChange = false } = {}) =>
  apiClient.post("/ctf-admin/exams/upload/", examFileForm(file, allowContentChange ? { allow_content_change: true } : {}));

export function uploadExamMaterial(slug, path, file) {
  const form = new FormData();
  form.append("path", path);
  form.append("file", file);
  return apiClient.post(`/ctf-admin/exams/${encodeURIComponent(slug)}/materials/`, form);
}

export const deleteExamMaterial = (slug, materialId) =>
  apiClient.delete(`/ctf-admin/exams/${encodeURIComponent(slug)}/materials/${materialId}/`);
