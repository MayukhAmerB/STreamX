import { lazy } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import ProtectedRoute from "../components/ProtectedRoute";
import ScrollToTop from "../components/ScrollToTop";
import { siteBrand } from "../config/siteBrand";
import { CONSOLE_PATH, LEGACY_CONSOLE_PATH } from "../features/app-shell/navConfig";
import AppLayout from "../layouts/AppLayout";
import { isLegacyRedirectLive } from "./legacyRedirects";
import { overhaulShellRoutes } from "./overhaulRoutes";
// Student profiles (WS-PROFILES): public /u/:handle and the Console editor /profile/public.
import { profilePublicRoutes, profileShellRoutes } from "../features/profiles/routes";
// Verifiable certificates (WS-CERTIFICATES): public /certificates and /certificates/:reference.
import { certificatePublicRoutes } from "../features/certificates/routes";
// Attendance and the class calendar (WS-ATTENDANCE): /attendance, /calendar and the Teach/Admin pages.
import { attendanceShellRoutes } from "../features/attendance/routes";
import { calendarShellRoutes } from "../features/calendar/routes";
// XP, levels and badges (WS-ENGAGEMENT): /achievements, /leaderboard, /levels and the public /achievements/:slug.
import { engagementPublicRoutes, engagementShellRoutes } from "../features/engagement-ui/routes";

// Carbon app shell for functional routes; lazy so Carbon never ships in the public website bundle.
const AppShellLayout = lazy(() => import("../features/app-shell/AppShellLayout"));
// Old Console URLs → the viewer's workspace URL (plan §3.3, §4.3); lazy for the same reason.
const WorkspaceRedirect = lazy(() => import("../features/app-shell/WorkspaceRedirect"));
const AboutPage = lazy(() => import("../pages/AboutPage"));
const AccountsDirectoryPage = lazy(() => import("../pages/AccountsDirectoryPage"));
const BroadcastingPage = lazy(() => import("../pages/BroadcastingPage"));
const ContactPage = lazy(() => import("../pages/ContactPage"));
const LegacyCourseDetailPage = lazy(() => import("../pages/CourseDetailPage"));
const CourseDetailPage = lazy(() => import("../pages/ProfessionalCoursePage"));
const CourseListPage = lazy(() => import("../pages/CourseListPage"));
const MyCoursesPage = lazy(() => import("../pages/MyCoursesPage"));
const CoursePaymentPage = lazy(() => import("../pages/CoursePaymentPage"));
const CoursePlayerPage = lazy(() => import("../pages/CoursePlayerPage"));
const CreateCoursePage = lazy(() => import("../pages/CreateCoursePage"));
const EditCoursePage = lazy(() => import("../pages/EditCoursePage"));
const FaqPage = lazy(() => import("../pages/FaqPage"));
const GuidesPage = lazy(() => import("../pages/GuidesPage"));
const HallOfFamePage = lazy(() => import("../pages/HallOfFamePage"));
const RewardsPage = lazy(() => import("../features/rewards/RewardsPage"));
const IdCardPage = lazy(() => import("../pages/IdCardPage"));
const InstructorDashboardPage = lazy(() => import("../pages/InstructorDashboardPage"));
const JoinAlSyedPage = lazy(() => import("../pages/JoinAlSyedPage"));
const JoinLivePage = lazy(() => import("../pages/JoinLivePage"));
const LandingPage = lazy(() => import("../pages/LandingPage"));
const LectureQuestionsPage = lazy(() => import("../pages/LectureQuestionsPage"));
const LiveClassesPage = lazy(() => import("../pages/LiveClassesPage"));
const LoginPage = lazy(() => import("../pages/LoginPage"));
// The e-mailed password reset link (backend users/views.py builds `/reset-password?uid=…&token=…`).
const ResetPasswordPage = lazy(() => import("../marketing/auth/ResetPasswordPage"));
const MeetingPage = lazy(() => import("../pages/MeetingPage"));
const NationalDeskPage = lazy(() => import("../pages/NationalDeskPage"));
const OsintToolsPage = lazy(() => import("../pages/OsintToolsPage"));
const ProfilePage = lazy(() => import("../pages/ProfilePage"));
const ReportsGradebookPage = lazy(() => import("../pages/ReportsGradebookPage"));
const ReportsGradingPage = lazy(() => import("../pages/ReportsGradingPage"));
const ReportsMarksPage = lazy(() => import("../pages/ReportsMarksPage"));
const ReportsPage = lazy(() => import("../pages/ReportsPage"));
const ReportsQueuePage = lazy(() => import("../pages/ReportsQueuePage"));
const ReportsTaskEditorPage = lazy(() => import("../pages/ReportsTaskEditorPage"));
const ReportsTaskPage = lazy(() => import("../pages/ReportsTaskPage"));
// Phase 3: Console exams (staff manage, instructors read) and the unified gradebook.
const ConsoleExamsPage = lazy(() => import("../pages/ConsoleExamsPage"));
const ConsoleExamDetailPage = lazy(() => import("../pages/ConsoleExamDetailPage"));
const GradebookPage = lazy(() => import("../pages/GradebookPage"));
// Console -> Upload class recording (resumable chunked upload + desktop uploader tokens).
const ConsoleRecordingUploadPage = lazy(() => import("../pages/ConsoleRecordingUploadPage"));
const StudentGradebookPage = lazy(() => import("../pages/GradebookPage").then((module) => ({ default: module.StudentGradebookPage })));
const TermsPage = lazy(() => import("../pages/TermsPage"));
// Console Home route module (WS-C rebuilds Home behind it).
const UsersCornerPage = lazy(() => import("../features/console-home/ConsoleHomePage"));
const WatchPage = lazy(() => import("../pages/WatchPage"));
// HackPath-philosophy marketing pages (BUILD_PLAN §2.1): plans, roadmap, tracks, bootcamp, free OSINT tier.
const PricingPage = lazy(() => import("../pages/PricingPage"));
const ChangelogPage = lazy(() => import("../pages/ChangelogPage"));
const RoadmapPage = lazy(() => import("../pages/RoadmapPage"));
const TrackPage = lazy(() => import("../pages/TrackPage"));
const BootcampPage = lazy(() => import("../pages/BootcampPage"));
const FreeDirectoryPage = lazy(() => import("../marketing/pages/FreeDirectoryPage"));
const NotFoundPage = lazy(() => import("../pages/NotFoundPage"));
// Monthly OSINT CTF (WS-MONTHLY-CTF): public page, Hall of Fame, certificate check, Console play page.
const MonthlyCtfPage = lazy(() => import("../features/monthly-ctf/MonthlyCtfPage"));
const MonthlyCtfHallOfFamePage = lazy(() => import("../features/monthly-ctf/MonthlyCtfHallOfFamePage"));
const MonthlyCtfPlayPage = lazy(() => import("../features/monthly-ctf/MonthlyCtfPlayPage"));

/**
 * Monthly CTF finalist certificates joined the certificate system: an old
 * /monthly-ctf/certificates/<slug> link opens /certificates/<slug>, which the
 * certificate page replaces with the canonical reference number.
 */
export function SeasonCertificateRedirect() {
  const { slug = "" } = useParams();
  return <Navigate to={`/certificates/${encodeURIComponent(slug)}`} replace />;
}

/** Old /courses/<id>/register links (the retired Pentesting application). */
export function RegisterRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/courses/${encodeURIComponent(id)}/payment`} replace />;
}

/**
 * The Console used to live at /users-corner. Shared links keep working: they
 * are replaced (no extra history entry) by /console, keeping ?query and #hash.
 */
export function LegacyConsoleRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: CONSOLE_PATH, search, hash }} replace />;
}

/**
 * An old Console URL: the old page until its new home is live, then a
 * redirect by role (routes/legacyRedirects.js holds the switch per URL).
 */
function legacy(path, page) {
  return isLegacyRedirectLive(path) ? <WorkspaceRedirect /> : page;
}

/**
 * Old staff URLs. Live ones redirect by role (students see not found);
 * the rest keep their page behind the original role check (ProtectedRoute:
 * not found or "Teaching is switched off", never the website home).
 */
function legacyGroup(guard, entries) {
  const key = Object.keys(guard).join("-");
  const live = entries.filter(([path]) => isLegacyRedirectLive(path));
  const kept = entries.filter(([path]) => !isLegacyRedirectLive(path));
  return [
    ...live.map(([path]) => <Route key={`live:${path}`} path={path} element={<WorkspaceRedirect />} />),
    kept.length ? (
      <Route key={`guard:${key}`} element={<ProtectedRoute {...guard} />}>
        {kept.map(([path, page]) => (
          <Route key={path} path={path} element={page} />
        ))}
      </Route>
    ) : null,
  ];
}

export default function AppRoutes() {
  const location = useLocation();
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/live-classes" element={<Navigate to="/courses?view=live" replace />} />
          <Route path="/about" element={<AboutPage />} />
          {siteBrand.id !== "owlcognito" ? <Route path="/as-accounts" element={<AccountsDirectoryPage />} /> : null}
          {siteBrand.id !== "owlcognito" ? <Route path="/national-desk" element={<NationalDeskPage />} /> : null}
          {siteBrand.id !== "owlcognito" ? <Route path="/join-alsyed" element={<JoinAlSyedPage />} /> : null}
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/faqs" element={<FaqPage />} />
          <Route path="/rewards" element={<RewardsPage />} />
          {siteBrand.id !== "owlcognito" ? <Route path="/hall-of-fame" element={<HallOfFamePage />} /> : null}
          <Route path="/courses" element={new URLSearchParams(location.search).get("view") === "owned" ? <Navigate to="/my-courses" replace /> : <CourseListPage />} />
          <Route path="/courses/:id" element={siteBrand.id === "owlcognito" ? <LegacyCourseDetailPage /> : <CourseDetailPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Pentesting used to have an application step; old links go straight to payment like OSINT. */}
          <Route path="/courses/:id/register" element={<RegisterRedirect />} />
          <Route path="/courses/:id/payment" element={<CoursePaymentPage />} />
          <Route path="/terms" element={<TermsPage />} />
          {siteBrand.youtube ? <Route path="/watch" element={<WatchPage />} /> : null}
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/changelog" element={<ChangelogPage />} />
          <Route path="/roadmap" element={<RoadmapPage />} />
          <Route path="/tracks/:track" element={<TrackPage />} />
          <Route path="/bootcamp" element={<BootcampPage />} />
          <Route path="/osint/free" element={<FreeDirectoryPage />} />
          <Route path="/monthly-ctf" element={<MonthlyCtfPage />} />
          <Route path="/monthly-ctf/hall-of-fame" element={<MonthlyCtfHallOfFamePage />} />
          <Route path="/monthly-ctf/certificates/:slug" element={<SeasonCertificateRedirect />} />
          {profilePublicRoutes()}
          {certificatePublicRoutes()}
          {engagementPublicRoutes()}
          {/* Unknown website addresses get a real "not found" page (noindex), not a silent redirect home. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        {/* Old Console address: redirect before the auth check so the login round trip lands on /console. */}
        <Route path={LEGACY_CONSOLE_PATH} element={<LegacyConsoleRedirect />} />
        <Route path={`${LEGACY_CONSOLE_PATH}/*`} element={<LegacyConsoleRedirect />} />
        {/* Functional (logged-in) app, the "Console": lazy Carbon shell with side nav / bottom nav and no website navbar or footer. */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShellLayout />}>
            <Route path={CONSOLE_PATH} element={<UsersCornerPage />} />
            <Route path="/my-courses" element={<MyCoursesPage />} />
            <Route path="/learn/:courseId" element={<CoursePlayerPage />} />
            <Route path="/courses/:id/live" element={<LiveClassesPage />} />
            <Route path="/join-live" element={<JoinLivePage />} />
            <Route path="/guides" element={<GuidesPage />} />
            <Route path="/osint-tools" element={<OsintToolsPage />} />
            <Route path="/monthly-ctf/play" element={<MonthlyCtfPlayPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            {profileShellRoutes()}
            {attendanceShellRoutes()}
            {calendarShellRoutes()}
            {engagementShellRoutes()}
            <Route path="/id-card" element={<IdCardPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/reports/marks" element={legacy("/reports/marks", <ReportsMarksPage />)} />
            <Route path="/reports/tasks/:taskId" element={<ReportsTaskPage />} />
            {/* Phase 3: unified gradebook (students: their own; staff and instructors: their batches). */}
            <Route path="/gradebook" element={<GradebookPage />} />
            {/* Control center is gone (owner decision D7): its URL opens the viewer's workspace home. */}
            <Route path="/control-center" element={<WorkspaceRedirect fallback={<Navigate to={CONSOLE_PATH} replace />} />} />
            {/* UI overhaul: Teach and Admin workspaces + Coursework exams (routes/overhaulRoutes.jsx). */}
            {overhaulShellRoutes()}
            {/* Old staff URLs: the old page behind its original role check until the new home is live. */}
            {legacyGroup({ requireModerator: true }, [
              ["/console/exams", <ConsoleExamsPage key="exams" />],
              ["/console/exams/:slug", <ConsoleExamDetailPage key="exam" />],
              ["/console/recordings/upload", <ConsoleRecordingUploadPage key="upload" />],
              ["/gradebook/students/:studentId", <StudentGradebookPage key="student" />],
              ["/report-grading", <ReportsGradingPage key="grading" />],
              ["/report-grading/tasks/new", <ReportsTaskEditorPage key="task-new" />],
              ["/report-grading/tasks/:taskId/edit", <ReportsTaskEditorPage key="task-edit" />],
              ["/report-grading/queue", <ReportsQueuePage key="queue" />],
              ["/report-grading/gradebook", <ReportsGradebookPage key="gradebook" />],
              ["/meeting", <MeetingPage key="meeting" />],
              ["/broadcasting", <BroadcastingPage key="broadcasting" />],
            ])}
            {legacyGroup({ requireAdmin: true }, [["/lecture-questions", <LectureQuestionsPage key="questions" />]])}
            {legacyGroup({ requireInstructor: true }, [
              ["/instructor/dashboard", <InstructorDashboardPage key="dashboard" />],
              ["/instructor/courses/new", <CreateCoursePage key="create" />],
              ["/instructor/courses/:id/edit", <EditCoursePage key="edit" />],
            ])}
          </Route>
        </Route>
      </Routes>
    </>
  );
}
