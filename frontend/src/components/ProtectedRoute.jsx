import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function ProtectedRoute({
  requireInstructor = false,
  requireAdmin = false,
  requireModerator = false,
}) {
  const { loading, isAuthenticated, isInstructor, isAdmin, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="p-6 text-sm text-[#BBBBBB]">Checking session...</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user?.terms_acceptance_required) {
    return <Navigate to="/terms" replace state={{ from: location.pathname }} />;
  }
  if (requireInstructor && !isInstructor) {
    return <Navigate to="/" replace />;
  }
  if (requireModerator && !(isInstructor || isAdmin)) {
    return <Navigate to="/join-live" replace />;
  }
  if (requireAdmin && !isAdmin) {
    return <Navigate to="/join-live" replace />;
  }
  return <Outlet />;
}

