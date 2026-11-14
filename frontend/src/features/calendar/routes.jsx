// Calendar routes, ready to drop into AppRoutes.jsx. OWNER: WS-ATTENDANCE (calendar).
// Inside <Route element={<AppShellLayout />}>: {calendarShellRoutes()}
import { lazy } from "react";
import { Route } from "react-router-dom";

const CalendarPage = lazy(() => import("./CalendarPage"));
const StaffCalendarPage = lazy(() => import("./StaffCalendarPage"));
const WorkspaceGuard = lazy(() => import("../../routes/WorkspaceGuard"));

export const CALENDAR_PATH = "/calendar";
export const TEACH_CALENDAR_PATH = "/console/teach/calendar";
export const ADMIN_CALENDAR_PATH = "/console/admin/calendar";

/** Signed-in Console pages (inside ProtectedRoute + AppShellLayout). */
export function calendarShellRoutes() {
  return [
    <Route key="calendar-me" path={CALENDAR_PATH} element={<CalendarPage />} />,
    <Route key="calendar-teach" element={<WorkspaceGuard workspace="teach" />}>
      <Route path={TEACH_CALENDAR_PATH} element={<StaffCalendarPage />} />
    </Route>,
    <Route key="calendar-admin" element={<WorkspaceGuard workspace="admin" />}>
      <Route path={ADMIN_CALENDAR_PATH} element={<StaffCalendarPage />} />
    </Route>,
  ];
}
