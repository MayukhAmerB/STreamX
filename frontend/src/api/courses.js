import apiClient from "./client";
import { dedupedGet } from "./requestDedup";

export const listCourses = (params = {}) =>
  dedupedGet("/courses/", params, () => apiClient.get("/courses/", { params }));
export const getCourse = (id) =>
  dedupedGet(`/courses/${id}/`, {}, () => apiClient.get(`/courses/${id}/`));
export const createCourse = (payload) => apiClient.post("/courses/", payload);
export const updateCourse = (id, payload) => apiClient.patch(`/courses/${id}/`, payload);
export const createSection = (payload) => apiClient.post("/sections/", payload);
export const updateSection = (id, payload) => apiClient.put(`/sections/${id}/`, payload);
export const deleteSection = (id) => apiClient.delete(`/sections/${id}/`);
export const createLecture = (payload) => apiClient.post("/lectures/", payload);
export const deleteLecture = (id) => apiClient.delete(`/lectures/${id}/`);
export const getLectureVideoUrl = (id) => apiClient.get(`/lectures/${id}/video/`);
export const getLectureProgress = (id) => apiClient.get(`/lectures/${id}/progress/`);
export const updateLectureProgress = (id, payload) => apiClient.put(`/lectures/${id}/progress/`, payload);
export const getMyCourses = () => dedupedGet("/my-courses/", {}, () => apiClient.get("/my-courses/"));
export const getInstructorCourses = () =>
  dedupedGet("/instructor/courses/", {}, () => apiClient.get("/instructor/courses/"));
export const listLiveClasses = (params = {}) =>
  dedupedGet("/live-classes/", params, () => apiClient.get("/live-classes/", { params }));
export const requestCourseEnrollment = (payload) => apiClient.post("/courses/enroll/", payload);
export const enrollInLiveClass = (payload) => apiClient.post("/live-classes/enroll/", payload);
export const submitPublicEnrollmentLead = (payload) => apiClient.post("/enrollment-leads/", payload);
