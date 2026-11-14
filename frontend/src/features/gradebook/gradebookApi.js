import apiClient from "../../api/client";
import { resolveApiBaseUrl } from "../../utils/backendUrl";

// Unified, read-only gradebook (weekly reports + CTF exams): /api/gradebook/…
export const getMyGradebook = () => apiClient.get("/gradebook/me/");
export const listGradebookCourses = () => apiClient.get("/gradebook/courses/");
export const getBatchGradebook = (courseId) => apiClient.get(`/gradebook/courses/${encodeURIComponent(courseId)}/`);
export const getStudentGradebook = (studentId) => apiClient.get(`/gradebook/students/${encodeURIComponent(studentId)}/`);
export const batchGradebookCsvHref = (courseId) => `${resolveApiBaseUrl()}/gradebook/courses/${encodeURIComponent(courseId)}/export.csv`;
