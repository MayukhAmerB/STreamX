// Learning progress for an owned course, normalised from the /my-courses/ API.
export function getCourseProgress(course) {
  const lectureCount = Math.max(0, Number(course?.lecture_count || 0));
  const completedCount = Math.min(lectureCount, Math.max(0, Number(course?.completed_lecture_count || 0)));
  const startedCount = Math.min(
    lectureCount,
    Math.max(completedCount, Number(course?.started_lecture_count || 0))
  );
  const suppliedPercent = Number(course?.progress_percent);
  const percent = Number.isFinite(suppliedPercent) && course?.progress_percent !== null && course?.progress_percent !== undefined
    ? Math.min(100, Math.max(0, Math.round(suppliedPercent)))
    : lectureCount > 0
      ? Math.round((completedCount / lectureCount) * 100)
      : 0;

  let status = "not-started";
  if (percent >= 100) status = "completed";
  else if (startedCount > 0 || percent > 0) status = "in-progress";

  let summary = `${lectureCount} ${lectureCount === 1 ? "lesson" : "lessons"}`;
  if (lectureCount === 0) summary = "Lessons coming soon";
  else if (status === "completed") summary = "All lessons done";
  else if (status === "in-progress") summary = `${completedCount} of ${lectureCount} lessons done`;

  return { lectureCount, completedCount, startedCount, percent, status, summary };
}

/** Short label for the primary action on a course tile. */
export function getCourseActionLabel(progress) {
  if (progress?.status === "completed") return "Review";
  if (progress?.status === "in-progress") return "Continue";
  return "Start";
}

export function formatCourseCategory(category) {
  return String(category || "").toLowerCase() === "web_pentesting" ? "Web & API pentesting" : "OSINT";
}
