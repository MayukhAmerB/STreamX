import apiClient from "./client";

export const listCourses = (params = {}) => apiClient.get("/courses/", { params });
export const getCourse = (id) => apiClient.get(`/courses/${id}/`);
export const createCourse = (payload) => apiClient.post("/courses/", payload);
export const updateCourse = (id, payload) => apiClient.patch(`/courses/${id}/`, payload);
export const createSection = (payload) => apiClient.post("/sections/", payload);
export const updateSection = (id, payload) => apiClient.put(`/sections/${id}/`, payload);
export const deleteSection = (id) => apiClient.delete(`/sections/${id}/`);
export const createLecture = (payload) => apiClient.post("/lectures/", payload);
export const deleteLecture = (id) => apiClient.delete(`/lectures/${id}/`);
export const getLectureVideoUrl = (id) => apiClient.get(`/lectures/${id}/video/`);
export const getMyCourses = () => apiClient.get("/my-courses/");
export const getInstructorCourses = () => apiClient.get("/instructor/courses/");
export const listLiveClasses = () => apiClient.get("/live-classes/");
export const enrollInLiveClass = (payload) => apiClient.post("/live-classes/enroll/", payload);
