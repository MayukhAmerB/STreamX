import { lazy, Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

// Lazy: the gate renders Console (Carbon) states, which must never ship in
// the public website bundle that imports this route guard.
const RoleGate = lazy(() => import("../routes/RoleGate"));

/**
 * Signed-in routes (plan §2.7, WS-B). Signed-out visitors go to /login and
 * viewers who must accept new terms to /terms (both with the return path).
 * A signed-in viewer who lacks the role for a gated route is NEVER sent to
 * the website home: they see "not found" when they can never act there, and
 * instructors see the "Teaching is switched off" page (FeatureGate) while
 * the Teachers section is off.
 */
export default function ProtectedRoute({ requireInstructor = false, requireAdmin = false, requireModerator = false }) {
  const { loading, isAuthenticated, isInstructor, isAdmin, user } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[#161616]" role="status" aria-live="polite">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-white/70 motion-reduce:animate-none" aria-hidden="true" />
        <p className="text-sm text-[#c6c6c6]">Checking your session…</p>
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (user?.terms_acceptance_required) {
    return <Navigate to="/terms" replace state={{ from: location.pathname }} />;
  }

  let gate = null;
  if (requireAdmin && !isAdmin) {
    gate = "not-found";
  } else if (requireInstructor && !isInstructor) {
    gate = "not-found";
  } else if (requireModerator && !(isInstructor || isAdmin)) {
    gate = "not-found";
  } else if ((requireInstructor || requireModerator) && isInstructor && !isAdmin) {
    // Non-staff instructors: teaching tools follow the Teachers section switch.
    gate = "teaching";
  }
  if (gate) {
    return (
      <Suspense fallback={null}>
        <RoleGate gate={gate} />
      </Suspense>
    );
  }
  return <Outlet />;
}
