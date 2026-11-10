import apiClient from "./client";

// Lecture likes and comments (see contracts/openapi.yaml, "Lecture engagement").
// Every endpoint requires a signed-in member who can watch the lecture.

export const getLectureEngagement = (lectureId) => apiClient.get(`/lectures/${lectureId}/engagement/`);

/** Idempotent like / unlike (safe to repeat, unlike the POST toggle). */
export const setLectureLike = (lectureId, liked) =>
  liked ? apiClient.put(`/lectures/${lectureId}/like/`) : apiClient.delete(`/lectures/${lectureId}/like/`);

export const toggleLectureLike = (lectureId) => apiClient.post(`/lectures/${lectureId}/like/`);

export const listLectureComments = (lectureId, { page = 1, pageSize = 20 } = {}) =>
  apiClient.get(`/lectures/${lectureId}/comments/`, { params: { page, page_size: pageSize } });

export const createLectureComment = (lectureId, body) =>
  apiClient.post(`/lectures/${lectureId}/comments/`, { body });

export const updateLectureComment = (commentId, body) =>
  apiClient.patch(`/lecture-comments/${commentId}/`, { body });

export const deleteLectureComment = (commentId) => apiClient.delete(`/lecture-comments/${commentId}/`);
