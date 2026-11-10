// Pure list logic for the student live pages (no React, no DOM).

export const SESSION_FILTERS = [
  { key: "all", label: "All" },
  { key: "meeting", label: "Meetings" },
  { key: "broadcasting", label: "Broadcasts" },
];

/** Show the search box only when the list is long enough to need it. */
export const SESSION_SEARCH_THRESHOLD = 5;

const STATUS_WEIGHT = { live: 1, scheduled: 2, ended: 3 };

/** Live first, then scheduled, newest first within each group. */
export function sortLiveSessions(sessions = []) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((a, b) => {
    const aWeight = STATUS_WEIGHT[a?.status] || 4;
    const bWeight = STATUS_WEIGHT[b?.status] || 4;
    if (aWeight !== bWeight) return aWeight - bWeight;
    return new Date(b?.created_at).getTime() - new Date(a?.created_at).getTime();
  });
}

/** Sessions linked to a course (directly or through its live class). */
export function filterSessionsForCourse(sessions = [], courseId = null) {
  const list = Array.isArray(sessions) ? sessions : [];
  const normalizedCourseId = Number(courseId || 0);
  if (!normalizedCourseId) return list;
  return list.filter((session) => {
    const linkedCourseId = Number(
      session?.linked_course?.id || session?.linked_live_class?.linked_course_id || 0
    );
    return linkedCourseId === normalizedCourseId;
  });
}

/** Mode filter (all / meeting / broadcasting) + search over title, description and host. */
export function filterLiveSessions(sessions = [], { mode = "all", query = "" } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  return (Array.isArray(sessions) ? sessions : []).filter((session) => {
    if (mode !== "all" && session?.session_type !== mode) return false;
    if (!needle) return true;
    return (
      String(session?.title || "").toLowerCase().includes(needle) ||
      String(session?.description || "").toLowerCase().includes(needle) ||
      String(session?.host?.full_name || "").toLowerCase().includes(needle)
    );
  });
}

export function countLiveSessions(sessions = []) {
  const list = Array.isArray(sessions) ? sessions : [];
  return {
    total: list.length,
    live: list.filter((session) => session?.status === "live").length,
    meeting: list.filter((session) => session?.session_type === "meeting").length,
    broadcasting: list.filter((session) => session?.session_type === "broadcasting").length,
  };
}

/** The type filter is only useful when both kinds of session exist. */
export function shouldShowSessionFilter(counts) {
  return Boolean(counts && counts.meeting > 0 && counts.broadcasting > 0);
}

export function sessionTypeLabel(sessionType) {
  return sessionType === "broadcasting" ? "Broadcast" : "Meeting";
}

export function sessionStatusLabel(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "live") return "Live";
  if (value === "scheduled") return "Scheduled";
  if (value === "ended") return "Ended";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Scheduled";
}
