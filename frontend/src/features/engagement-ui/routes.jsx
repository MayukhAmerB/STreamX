// Engagement routes, ready to drop into AppRoutes.jsx. OWNER: WS-LEARN.
// AppRoutes.jsx belongs to WS-MKT, so it only spreads these two helpers:
//   inside <Route element={<AppLayout />}>      {engagementPublicRoutes()}
//   inside <Route element={<AppShellLayout />}> {engagementShellRoutes()}
// Each page is its own lazy chunk; nothing loads until the route is opened.
import { lazy } from "react";
import { Route } from "react-router-dom";

const AchievementsPage = lazy(() => import("./AchievementsPage"));
const LeaderboardPage = lazy(() => import("./LeaderboardPage"));
const AchievementVerifyPage = lazy(() => import("./AchievementVerifyPage"));
const LevelsPage = lazy(() => import("./LevelsPage"));

export const ACHIEVEMENTS_PATH = "/achievements";
export const LEADERBOARD_PATH = "/leaderboard";
export const LEVELS_PATH = "/levels";

/** Signed-in Console pages (inside ProtectedRoute + AppShellLayout). */
export function engagementShellRoutes() {
  return [
    <Route key="engagement-achievements" path={ACHIEVEMENTS_PATH} element={<AchievementsPage />} />,
    <Route key="engagement-leaderboard" path={LEADERBOARD_PATH} element={<LeaderboardPage />} />,
    <Route key="engagement-levels" path={LEVELS_PATH} element={<LevelsPage />} />,
  ];
}

/** Public certificate verification (no sign-in; inside the website layout). */
export function engagementPublicRoutes() {
  return [<Route key="engagement-verify" path={`${ACHIEVEMENTS_PATH}/:slug`} element={<AchievementVerifyPage />} />];
}
