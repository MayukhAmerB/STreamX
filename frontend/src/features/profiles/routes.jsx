// Student profile routes. OWNER: WS-PROFILES. AppRoutes renders
// `profilePublicRoutes()` inside the website layout and
// `profileShellRoutes()` inside the signed-in Console shell.
import { lazy } from "react";
import { Route } from "react-router-dom";

const PublicProfilePage = lazy(() => import("./PublicProfilePage"));
const ProfileEditorPage = lazy(() => import("./ProfileEditorPage"));

export const PROFILE_PUBLIC_PATH = "/u/:handle";
export const PROFILE_EDITOR_PATH = "/profile/public";

/** Public page (no sign-in needed; the API enforces members-only visibility). */
export function profilePublicRoutes() {
  return [<Route key="profile-public" path={PROFILE_PUBLIC_PATH} element={<PublicProfilePage />} />];
}

/** The owner's editor, inside the Console shell (ProtectedRoute + AppShellLayout). */
export function profileShellRoutes() {
  return [<Route key="profile-editor" path={PROFILE_EDITOR_PATH} element={<ProfileEditorPage />} />];
}
