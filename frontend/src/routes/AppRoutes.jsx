import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "../components/ProtectedRoute";
import AppLayout from "../layouts/AppLayout";
import AdminControlCenterPage from "../pages/AdminControlCenterPage";
import AboutPage from "../pages/AboutPage";
import BroadcastingPage from "../pages/BroadcastingPage";
import ContactPage from "../pages/ContactPage";
import CourseDetailPage from "../pages/CourseDetailPage";
import CourseListPage from "../pages/CourseListPage";
import CoursePlayerPage from "../pages/CoursePlayerPage";
import CoursePaymentPage from "../pages/CoursePaymentPage";
import CreateCoursePage from "../pages/CreateCoursePage";
import EditCoursePage from "../pages/EditCoursePage";
import InstructorDashboardPage from "../pages/InstructorDashboardPage";
import JoinLivePage from "../pages/JoinLivePage";
import LandingPage from "../pages/LandingPage";
import LiveClassesPage from "../pages/LiveClassesPage";
import LoginPage from "../pages/LoginPage";
import MeetingPage from "../pages/MeetingPage";
import MyCoursesPage from "../pages/MyCoursesPage";
import ProfilePage from "../pages/ProfilePage";
import RegisterPage from "../pages/RegisterPage";

export default function AppRoutes() {
  return (
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
        <Route element={<ProtectedRoute requireAdmin />}>
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
  );
}
