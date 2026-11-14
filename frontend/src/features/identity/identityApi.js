import apiClient from "../../api/client";

// GET /api/me/identity/ : the signed-in student's own identity block
// (roll number, real name, handle, stats). Read-only; ?course= scopes stats.
export const getMyIdentity = (courseId) =>
  apiClient.get("/me/identity/", { params: courseId ? { course: courseId } : undefined });
