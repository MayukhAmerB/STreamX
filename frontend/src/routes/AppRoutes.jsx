import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "../components/ProtectedRoute";
import ScrollToTop from "../components/ScrollToTop";
import AppLayout from "../layouts/AppLayout";

const AdminControlCenterPage = lazy(() => import("../pages/AdminControlCenterPage"));
const AboutPage = lazy(() => import("../pages/AboutPage"));
const BroadcastingPage = lazy(() => import("../pages/BroadcastingPage"));
const ContactPage = lazy(() => import("../pages/ContactPage"));
const CourseDetailPage = lazy(() => import("../pages/CourseDetailPage"));
const CourseListPage = lazy(() => import("../pages/CourseListPage"));
const CoursePlayerPage = lazy(() => import("../pages/CoursePlayerPage"));
const CoursePaymentPage = lazy(() => import("../pages/CoursePaymentPage"));
const CreateCoursePage = lazy(() => import("../pages/CreateCoursePage"));
const EditCoursePage = lazy(() => import("../pages/EditCoursePage"));
const InstructorDashboardPage = lazy(() => import("../pages/InstructorDashboardPage"));
const JoinLivePage = lazy(() => import("../pages/JoinLivePage"));
const LandingPage = lazy(() => import("../pages/LandingPage"));
const LiveClassesPage = lazy(() => import("../pages/LiveClassesPage"));
const LoginPage = lazy(() => import("../pages/LoginPage"));
const MeetingPage = lazy(() => import("../pages/MeetingPage"));
const MyCoursesPage = lazy(() => import("../pages/MyCoursesPage"));
const ProfilePage = lazy(() => import("../pages/ProfilePage"));
const RegisterPage = lazy(() => import("../pages/RegisterPage"));

export default function AppRoutes() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/live-classes" element={<LiveClassesPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/courses" element={<CourseListPage />} />
          <Route path="/courses/:id" element={<CourseDetailPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/my-courses" element={<MyCoursesPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/learn/:courseId" element={<CoursePlayerPage />} />
            <Route path="/courses/:id/payment" element={<CoursePaymentPage />} />
            <Route path="/join-live" element={<JoinLivePage />} />
          </Route>
          <Route element={<ProtectedRoute requireModerator />}>
            <Route path="/control-center" element={<AdminControlCenterPage />} />
            <Route path="/meeting" element={<MeetingPage />} />
            <Route path="/broadcasting" element={<BroadcastingPage />} />
          </Route>
          <Route element={<ProtectedRoute requireInstructor />}>
            <Route path="/instructor/dashboard" element={<InstructorDashboardPage />} />
            <Route path="/instructor/courses/new" element={<CreateCoursePage />} />
            <Route path="/instructor/courses/:id/edit" element={<EditCoursePage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
