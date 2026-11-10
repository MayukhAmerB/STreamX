import { lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import ProtectedRoute from "../components/ProtectedRoute";
import ScrollToTop from "../components/ScrollToTop";
import { siteBrand } from "../config/siteBrand";
import AppLayout from "../layouts/AppLayout";

// Carbon app shell for functional routes; lazy so Carbon never ships in the public website bundle.
const AppShellLayout = lazy(() => import("../features/app-shell/AppShellLayout"));
const AdminControlCenterPage = lazy(() => import("../pages/AdminControlCenterPage"));
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
const IdCardPage = lazy(() => import("../pages/IdCardPage"));
const InstructorDashboardPage = lazy(() => import("../pages/InstructorDashboardPage"));
const JoinAlSyedPage = lazy(() => import("../pages/JoinAlSyedPage"));
const JoinLivePage = lazy(() => import("../pages/JoinLivePage"));
const LandingPage = lazy(() => import("../pages/LandingPage"));
const PentestingRegistrationPage = lazy(() => import("../pages/PentestingRegistrationPage"));
const LectureQuestionsPage = lazy(() => import("../pages/LectureQuestionsPage"));
const LiveClassesPage = lazy(() => import("../pages/LiveClassesPage"));
const LoginPage = lazy(() => import("../pages/LoginPage"));
const MeetingPage = lazy(() => import("../pages/MeetingPage"));
const NationalDeskPage = lazy(() => import("../pages/NationalDeskPage"));
const OsintToolsPage = lazy(() => import("../pages/OsintToolsPage"));
const ProfilePage = lazy(() => import("../pages/ProfilePage"));
const TermsPage = lazy(() => import("../pages/TermsPage"));
const UsersCornerPage = lazy(() => import("../pages/UsersCornerPage"));

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
          {siteBrand.id !== "owlcognito" ? <Route path="/hall-of-fame" element={<HallOfFamePage />} /> : null}
          <Route path="/courses" element={new URLSearchParams(location.search).get("view") === "owned" ? <Navigate to="/my-courses" replace /> : <CourseListPage />} />
          <Route path="/courses/:id" element={siteBrand.id === "owlcognito" ? <LegacyCourseDetailPage /> : <CourseDetailPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/courses/:id/register" element={<PentestingRegistrationPage />} />
          <Route path="/courses/:id/payment" element={<CoursePaymentPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Route>
        {/* Functional (logged-in) app, "User's Corner": lazy Carbon shell with side nav / bottom nav and no website navbar or footer. */}
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShellLayout />}>
            <Route path="/users-corner" element={<UsersCornerPage />} />
            <Route path="/my-courses" element={<MyCoursesPage />} />
            <Route path="/learn/:courseId" element={<CoursePlayerPage />} />
            <Route path="/courses/:id/live" element={<LiveClassesPage />} />
            <Route path="/join-live" element={<JoinLivePage />} />
            <Route path="/guides" element={<GuidesPage />} />
            <Route path="/osint-tools" element={<OsintToolsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/id-card" element={<IdCardPage />} />
            {/* Staff tools share the same shell instance; each group keeps its original role check. */}
            <Route element={<ProtectedRoute requireModerator />}>
              <Route path="/control-center" element={<AdminControlCenterPage />} />
              <Route path="/meeting" element={<MeetingPage />} />
              <Route path="/broadcasting" element={<BroadcastingPage />} />
            </Route>
            <Route element={<ProtectedRoute requireAdmin />}>
              <Route path="/lecture-questions" element={<LectureQuestionsPage />} />
            </Route>
            <Route element={<ProtectedRoute requireInstructor />}>
              <Route path="/instructor/dashboard" element={<InstructorDashboardPage />} />
              <Route path="/instructor/courses/new" element={<CreateCoursePage />} />
              <Route path="/instructor/courses/:id/edit" element={<EditCoursePage />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
