// Attendance routes, ready to drop into AppRoutes.jsx. OWNER: WS-ATTENDANCE.
// Inside <Route element={<AppShellLayout />}>: {attendanceShellRoutes()}
// Each page is its own lazy chunk; nothing loads until the route is opened.
import { lazy } from "react";
import { Route } from "react-router-dom";

const AttendancePage = lazy(() => import("./AttendancePage"));
const StaffAttendancePage = lazy(() => import("./StaffAttendancePage"));
const WorkspaceGuard = lazy(() => import("../../routes/WorkspaceGuard"));

export const ATTENDANCE_PATH = "/attendance";
export const TEACH_ATTENDANCE_PATH = "/console/teach/attendance";
export const ADMIN_ATTENDANCE_PATH = "/console/admin/attendance";

/** Signed-in Console pages (inside ProtectedRoute + AppShellLayout). */
export function attendanceShellRoutes() {
  return [
    <Route key="attendance-me" path={ATTENDANCE_PATH} element={<AttendancePage />} />,
    <Route key="attendance-teach" element={<WorkspaceGuard workspace="teach" />}>
      <Route path={TEACH_ATTENDANCE_PATH} element={<StaffAttendancePage />} />
    </Route>,
    <Route key="attendance-admin" element={<WorkspaceGuard workspace="admin" />}>
      <Route path={ADMIN_ATTENDANCE_PATH} element={<StaffAttendancePage />} />
    </Route>,
  ];
}
