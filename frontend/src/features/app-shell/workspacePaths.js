// Old Console URLs → the workspace URL for this viewer (UI overhaul plan
// §3.3, §4.3). OWNER: WS-B (created by WS-0). Pure; used by
// <WorkspaceRedirect/> and its tests. `{ws}` is "admin" for staff and
// "teach" for instructors; students have no workspace (null → caller shows
// not found or keeps the old page).

export const TEACH_ROOT = "/console/teach";
export const ADMIN_ROOT = "/console/admin";

export function workspaceFor({ isAdmin = false, isInstructor = false } = {}) {
  if (isAdmin) return "admin";
  if (isInstructor) return "teach";
  return null;
}

const enc = encodeURIComponent;

// [pattern, (match, ws, params) => path] in priority order. `ws` may be null
// for rules that apply to everyone.
const RULES = [
  [/^\/reports\/marks\/?$/, () => "/gradebook", { everyone: true }],
  [/^\/control-center\/?$/, (_m, ws) => `/console/${ws}`],
  [/^\/instructor\/dashboard\/?$/, (_m, ws) => `/console/${ws}`],
  [/^\/instructor\/courses\/new\/?$/, (_m, ws) => `/console/${ws}/courses/new`],
  [/^\/instructor\/courses\/([^/]+)\/edit\/?$/, (m, ws) => `/console/${ws}/courses/${enc(decodeURIComponent(m[1]))}`],
  [/^\/meeting\/?$/, (_m, ws) => `/console/${ws}/classes?mode=meeting`],
  [
    /^\/broadcasting\/?$/,
    (_m, ws, params) => {
      const session = params.get("session");
      return session ? `/console/${ws}/classes/${enc(session)}/studio` : `/console/${ws}/classes?mode=broadcast`;
    },
  ],
  [/^\/console\/recordings\/upload\/?$/, (_m, ws) => `/console/${ws}/recordings/upload`],
  [/^\/report-grading\/?$/, (_m, ws) => `/console/${ws}/grading/tasks`],
  [/^\/report-grading\/queue\/?$/, (_m, ws) => `/console/${ws}/grading/queue`],
  [/^\/report-grading\/gradebook\/?$/, (_m, ws) => `/console/${ws}/grading/marks`],
  [/^\/report-grading\/tasks\/new\/?$/, (_m, ws) => `/console/${ws}/grading/tasks/new`],
  [/^\/report-grading\/tasks\/([^/]+)\/edit\/?$/, (m, ws) => `/console/${ws}/grading/tasks/${m[1]}/edit`],
  [/^\/gradebook\/students\/([^/]+)\/?$/, (m, ws) => `/console/${ws}/grading/students/${m[1]}`],
  [/^\/console\/exams\/?$/, (_m, ws) => `/console/${ws}/exams`],
  [/^\/console\/exams\/([^/]+)\/?$/, (m, ws) => `/console/${ws}/exams/${m[1]}`],
  [/^\/lecture-questions\/?$/, (_m, ws) => (ws === "admin" ? `${ADMIN_ROOT}/community?tab=questions` : null)],
];

/** Every old path pattern this module knows (for docs and tests). */
export const LEGACY_PATTERNS = RULES.map(([pattern]) => pattern);

/**
 * Resolves an old URL for a viewer. Returns `{ pathname, search }` or null
 * when the URL is not an old one or the viewer has no workspace for it.
 * Query parameters of the old URL are kept unless the rule consumed them.
 */
export function resolveWorkspacePath(pathname, search = "", viewer = {}) {
  const params = new URLSearchParams(search || "");
  const ws = workspaceFor(viewer);
  for (const [pattern, build, options = {}] of RULES) {
    const match = pattern.exec(pathname || "");
    if (!match) continue;
    if (!ws && !options.everyone) return null;
    const target = build(match, ws, params);
    if (!target) return null;
    const [targetPath, targetQuery = ""] = target.split("?");
    const merged = new URLSearchParams(targetQuery);
    params.forEach((value, key) => {
      if (key === "session" && /\/studio$/.test(targetPath)) return;
      if (!merged.has(key)) merged.set(key, value);
    });
    const query = merged.toString();
    return { pathname: targetPath, search: query ? `?${query}` : "" };
  }
  return null;
}

/** /console/teach/... → /console/admin/... (staff opening an instructor link). */
export function teachToAdminPath(pathname) {
  return String(pathname || "").replace(/^\/console\/teach(?=\/|$)/, ADMIN_ROOT);
}
