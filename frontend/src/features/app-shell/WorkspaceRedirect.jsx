// Sends an old Console URL to the viewer's workspace URL (UI overhaul plan
// §3.3). OWNER: WS-B.
//
// Mounted by routes/AppRoutes.jsx for every old URL whose switch is on in
// routes/legacyRedirects.js, and by routes/RoleGate.jsx when a signed-in
// viewer opens an old URL their role never opened (staff on an instructor
// link). Viewers without a workspace see `fallback` (default: not found);
// never the website home.
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { NotFoundState } from "./ui";
import { resolveWorkspacePath } from "./workspacePaths";

export default function WorkspaceRedirect({ fallback = <NotFoundState /> }) {
  const { pathname, search, hash } = useLocation();
  const { isAdmin, isInstructor } = useAuth() || {};
  const target = resolveWorkspacePath(pathname, search, { isAdmin, isInstructor });
  if (!target) return fallback;
  return <Navigate to={{ ...target, hash }} replace />;
}
