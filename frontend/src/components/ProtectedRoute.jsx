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
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-black">
        <div className="relative h-12 w-12">
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-white/50 border-r-white/10 animate-spin" />
        </div>
        <p className="mt-4 text-xs uppercase tracking-widest text-white/60">Checking session...</p>
      </div>
    );
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

