// New Console routes of the UI overhaul (plan §3.3, §4.3). OWNER: WS-B
// (created by WS-0). Rendered inside the signed-in AppShellLayout by
// AppRoutes. Each element is the page module of the owning workstream (a
// placeholder until it is built) or, where the new URL shows a page that
// exists today, that page itself. Old URLs are untouched here; see
// features/app-shell/WorkspaceRedirect.jsx.
import { lazy } from "react";
import { Route } from "react-router-dom";

// Lazy like every Console module: Carbon must never ship in the public website bundle.
const WorkspaceGuard = lazy(() => import("./WorkspaceGuard"));

// Shared pages that already exist (same component on both workspace trees).
const ConsoleExamsPage = lazy(() => import("../pages/ConsoleExamsPage"));
const ConsoleExamDetailPage = lazy(() => import("../pages/ConsoleExamDetailPage"));
const ConsoleRecordingUploadPage = lazy(() => import("../pages/ConsoleRecordingUploadPage"));
// Learn (WS-C).
const CourseworkExamsPage = lazy(() => import("../features/coursework/CourseworkExamsPage"));
const TeachTodayPage = lazy(() => import("../features/teach-today/TeachTodayPage"));
// Teach content and assessment (WS-D2).
const TeachCoursesPage = lazy(() => import("../features/teach-courses/TeachCoursesPage"));
const CourseEditorPage = lazy(() => import("../features/teach-courses/CourseEditorPage"));
const GradingPage = lazy(() => import("../features/grading/GradingPage"));
const GradingTaskEditorPage = lazy(() => import("../features/grading/GradingTaskEditorPage"));
const GradingStudentPage = lazy(() => import("../features/grading/GradingStudentPage"));
// Classes, studio, recordings (WS-D1).
const ClassesPage = lazy(() => import("../features/classes/ClassesPage"));
const HostStudioPage = lazy(() => import("../features/classes/HostStudioPage"));
const MyRecordingsPage = lazy(() => import("../features/recording-uploads/MyRecordingsPage"));
// Admin workspace (WS-G).
const AdminHomePage = lazy(() => import("../features/admin/AdminHomePage"));
const AdminActivityPage = lazy(() => import("../features/admin/AdminActivityPage"));
const AdminRequestsPage = lazy(() => import("../features/admin/AdminRequestsPage"));
const AdminRecordingsPage = lazy(() => import("../features/admin/AdminRecordingsPage"));
const AdminCommunityPage = lazy(() => import("../features/admin/AdminCommunityPage"));
const AdminFeaturesPage = lazy(() => import("../features/admin/AdminFeaturesPage"));
const AdminHealthPage = lazy(() => import("../features/admin/AdminHealthPage"));
const AdminBackOfficePage = lazy(() => import("../features/admin/AdminBackOfficePage"));

/** Pages that exist in both the Teach and the Admin workspace (`{ws}` routes). */
function sharedWorkspaceRoutes(ws) {
  const root = `/console/${ws}`;
  return [
    <Route key={`${ws}-courses`} path={`${root}/courses`} element={<TeachCoursesPage />} />,
    <Route key={`${ws}-courses-new`} path={`${root}/courses/new`} element={<CourseEditorPage />} />,
    <Route key={`${ws}-course`} path={`${root}/courses/:id`} element={<CourseEditorPage />} />,
    <Route key={`${ws}-classes`} path={`${root}/classes`} element={<ClassesPage />} />,
    <Route key={`${ws}-studio`} path={`${root}/classes/:sessionId/studio`} element={<HostStudioPage />} />,
    <Route key={`${ws}-upload`} path={`${root}/recordings/upload`} element={<ConsoleRecordingUploadPage />} />,
    <Route key={`${ws}-grading`} path={`${root}/grading`} element={<GradingPage />} />,
    <Route key={`${ws}-grading-tab`} path={`${root}/grading/:tab`} element={<GradingPage />} />,
    <Route key={`${ws}-task-new`} path={`${root}/grading/tasks/new`} element={<GradingTaskEditorPage />} />,
    <Route key={`${ws}-task-edit`} path={`${root}/grading/tasks/:taskId/edit`} element={<GradingTaskEditorPage />} />,
    <Route key={`${ws}-student`} path={`${root}/grading/students/:studentId`} element={<GradingStudentPage />} />,
    <Route key={`${ws}-exams`} path={`${root}/exams`} element={<ConsoleExamsPage />} />,
    <Route key={`${ws}-exam`} path={`${root}/exams/:slug`} element={<ConsoleExamDetailPage />} />,
  ];
}

/** Every new Console route (call inside the AppShellLayout route). */
export function overhaulShellRoutes() {
  return [
    <Route key="coursework-exams" path="/coursework/exams" element={<CourseworkExamsPage />} />,
    <Route key="teach" element={<WorkspaceGuard workspace="teach" />}>
      <Route path="/console/teach" element={<TeachTodayPage />} />
      <Route path="/console/teach/recordings" element={<MyRecordingsPage />} />
      {sharedWorkspaceRoutes("teach")}
    </Route>,
    <Route key="admin" element={<WorkspaceGuard workspace="admin" />}>
      <Route path="/console/admin" element={<AdminHomePage />} />
      <Route path="/console/admin/activity" element={<AdminActivityPage />} />
      <Route path="/console/admin/requests" element={<AdminRequestsPage />} />
      <Route path="/console/admin/recordings" element={<AdminRecordingsPage />} />
      <Route path="/console/admin/community" element={<AdminCommunityPage />} />
      <Route path="/console/admin/settings/features" element={<AdminFeaturesPage />} />
      <Route path="/console/admin/system/health" element={<AdminHealthPage />} />
      {/* Wave 2: link to the back office until each page is built. */}
      <Route path="/console/admin/payments" element={<AdminBackOfficePage section="payments" />} />
      <Route path="/console/admin/people" element={<AdminBackOfficePage section="people" />} />
      <Route path="/console/admin/batches" element={<AdminBackOfficePage section="batches" />} />
      <Route path="/console/admin/leads" element={<AdminBackOfficePage section="leads" />} />
      <Route path="/console/admin/classes/chat" element={<AdminBackOfficePage section="chat" />} />
      <Route path="/console/admin/settings/website" element={<AdminBackOfficePage section="website" />} />
      <Route path="/console/admin/settings/live" element={<AdminBackOfficePage section="live" />} />
      <Route path="/console/admin/system/tokens" element={<AdminBackOfficePage section="tokens" />} />
      {sharedWorkspaceRoutes("admin")}
    </Route>,
  ];
}

/** Every new path pattern (for tests and the visual page list). */
export const OVERHAUL_PATHS = Object.freeze([
  "/coursework/exams",
  "/console/teach",
  "/console/teach/recordings",
  ...["teach", "admin"].flatMap((ws) =>
    [
      "courses",
      "courses/new",
      "courses/:id",
      "classes",
      "classes/:sessionId/studio",
      "recordings/upload",
      "grading",
      "grading/:tab",
      "grading/tasks/new",
      "grading/tasks/:taskId/edit",
      "grading/students/:studentId",
      "exams",
      "exams/:slug",
    ].map((suffix) => `/console/${ws}/${suffix}`)
  ),
  "/console/admin",
  "/console/admin/activity",
  "/console/admin/requests",
  "/console/admin/recordings",
  "/console/admin/community",
  "/console/admin/settings/features",
  "/console/admin/system/health",
  "/console/admin/payments",
  "/console/admin/people",
  "/console/admin/batches",
  "/console/admin/leads",
  "/console/admin/classes/chat",
  "/console/admin/settings/website",
  "/console/admin/settings/live",
  "/console/admin/system/tokens",
]);
