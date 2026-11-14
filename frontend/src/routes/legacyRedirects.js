// Which old Console URLs already redirect to their workspace URL (plan §3.3,
// §4.3). OWNER: WS-B. The map itself lives in
// features/app-shell/workspacePaths.js; this file is the switch per URL.
//
// A URL goes live when its new page is real (not a RoutePlaceholder) and
// the E2E journeys that open it use the new URL (WS-I). Until then the old
// route keeps rendering today's page, so bookmarks and journeys keep working.
// Flip an entry to true (or add it to VITE_LEGACY_REDIRECTS, comma separated,
// "all" for every entry) to switch it over; no other change is needed.
//
// Note: the owning workstreams already turned most old page modules into
// redirects themselves (WS-D2: grading and instructor pages via
// <WorkspaceRedirect/>; WS-D1: /meeting and /broadcasting via
// LegacyClassesRedirect, which also maps ?session= to the studio; WS-C:
// /reports/marks → /gradebook). Those stay false here on purpose so the
// page-level redirect (the smarter one for /broadcasting) keeps working.

export const LEGACY_REDIRECTS = Object.freeze({
  // Owner decision D7: Control center is removed (always redirects, see AppRoutes).
  "/control-center": true,
  // Same page component on the new URL (the Upload page is shared by both trees).
  "/console/recordings/upload": true,
  // Coursework hub (WS-C): "My marks" becomes the Grades tab.
  "/reports/marks": false,
  // Exams (shared page; exam-console journey asserts the old URL until WS-I updates it).
  "/console/exams": false,
  "/console/exams/:slug": false,
  // Grading (WS-D2).
  "/report-grading": false,
  "/report-grading/tasks/new": false,
  "/report-grading/tasks/:taskId/edit": false,
  "/report-grading/queue": false,
  "/report-grading/gradebook": false,
  "/gradebook/students/:studentId": false,
  // Classes and studio (WS-D1).
  "/meeting": false,
  "/broadcasting": false,
  // Teach courses (WS-D2).
  "/instructor/dashboard": false,
  "/instructor/courses/new": false,
  "/instructor/courses/:id/edit": false,
  // Community › Questions (WS-G, D2).
  "/lecture-questions": false,
});

function envOverrides() {
  try {
    const raw = String(import.meta.env?.VITE_LEGACY_REDIRECTS || "").trim();
    if (!raw) return new Set();
    return new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

const FORCED = envOverrides();

export function isLegacyRedirectLive(path) {
  if (FORCED.has("all") || FORCED.has(path)) return Object.prototype.hasOwnProperty.call(LEGACY_REDIRECTS, path);
  return LEGACY_REDIRECTS[path] === true;
}
