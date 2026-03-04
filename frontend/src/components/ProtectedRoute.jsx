import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function ProtectedRoute({ requireInstructor = false, requireAdmin = false }) {
  const { loading, isAuthenticated, isInstructor, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="p-6 text-sm text-[#b7c0b0]">Checking session...</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (requireInstructor && !isInstructor) {
    return <Navigate to="/" replace />;
  }
  if (requireAdmin && !isAdmin) {
    return <Navigate to="/join-live" replace />;
  }
  return <Outlet />;
}

