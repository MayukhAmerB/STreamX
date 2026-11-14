// Course authoring calls (Teach › Courses). OWNER: WS-D2. Thin wrappers over
// the existing courses API; reads go through api/courses (deduped GETs).
import apiClient from "../../api/client";

export { createCourse, createLecture, createSection, deleteLecture, deleteSection, getCourse, getInstructorCourses, listCourses, updateCourse } from "../../api/courses";

/** PUT /sections/:id/ (title, description, order). */
export const saveSection = (id, payload) => apiClient.put(`/sections/${id}/`, payload);

/** PUT /lectures/:id/ (title, description, order, is_preview; the video stays). */
export const saveLecture = (id, payload) => apiClient.put(`/lectures/${id}/`, payload);
