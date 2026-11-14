// Which workspace tree a Teach/Admin page is mounted on (UI overhaul plan
// §3.3). OWNER: WS-D2. Shared pages (Courses, Grading, Exams) are the same
// component under /console/teach and /console/admin; every link they build
// stays inside the tree the viewer is in. On an old URL (e.g. /console/exams)
// the viewer's role decides: staff → admin, everyone else → teach.
import { useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { ADMIN_ROOT, TEACH_ROOT } from "../app-shell/workspacePaths";

export function workspaceRootFor(pathname = "", { isAdmin = false } = {}) {
  const path = String(pathname || "");
  if (path === ADMIN_ROOT || path.startsWith(`${ADMIN_ROOT}/`)) return ADMIN_ROOT;
  if (path === TEACH_ROOT || path.startsWith(`${TEACH_ROOT}/`)) return TEACH_ROOT;
  return isAdmin ? ADMIN_ROOT : TEACH_ROOT;
}

/** "/console/admin" or "/console/teach" for the page being rendered. */
export function useWorkspaceRoot() {
  const { pathname } = useLocation();
  const { isAdmin } = useAuth() || {};
  return workspaceRootFor(pathname, { isAdmin });
}

/** Link builders for the Grading pages under one workspace root. */
export function gradingPaths(root) {
  const base = `${root}/grading`;
  const query = (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
    });
    const text = search.toString();
    return text ? `?${text}` : "";
  };
  return {
    base,
    tab: (tab, params) => `${base}/${tab}${query(params)}`,
    queue: (params) => `${base}/queue${query(params)}`,
    tasks: (params) => `${base}/tasks${query(params)}`,
    marks: (params) => `${base}/marks${query(params)}`,
    settings: (params) => `${base}/settings${query(params)}`,
    newTask: (params) => `${base}/tasks/new${query(params)}`,
    editTask: (taskId) => `${base}/tasks/${encodeURIComponent(taskId)}/edit`,
    student: (studentId) => `${base}/students/${encodeURIComponent(studentId)}`,
  };
}
