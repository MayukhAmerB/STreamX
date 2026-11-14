// Who may open a workspace tree (UI overhaul plan §2.7, §3.1). OWNER: WS-B
// (created by WS-0). Never redirects to the website home:
//   admin  staff → page; anyone else → not found (they can never act there)
//   teach  staff → the same page under /console/admin; students → not found;
//          instructors → <FeatureGate feature="teaching"> (off page with reason)
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { NotFoundState } from "../features/app-shell/ui";
import { teachToAdminPath } from "../features/app-shell/workspacePaths";
import { FeatureGate } from "../features/capabilities";
import { useAuth } from "../hooks/useAuth";
// The Teach + Admin design language (HackPath philosophy), scoped to those workspaces.
import "../features/admin/staff-theme.scss";

export default function WorkspaceGuard({ workspace }) {
  const { isAdmin, isInstructor } = useAuth() || {};
  const { pathname, search, hash } = useLocation();

  if (workspace === "admin") {
    return isAdmin ? <Outlet /> : <NotFoundState />;
  }
  if (isAdmin) {
    return <Navigate to={{ pathname: teachToAdminPath(pathname), search, hash }} replace />;
  }
  if (!isInstructor) {
    return <NotFoundState />;
  }
  return <FeatureGate feature="teaching" />;
}
