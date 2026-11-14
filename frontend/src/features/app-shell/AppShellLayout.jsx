import "./styles/carbon-app.scss";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { useAuth } from "../../hooks/useAuth";
import { resolveDjangoAdminUrl } from "../../utils/backendUrl";
import useCapabilities from "../capabilities/useCapabilities";
import { CommandPalette, openCommandPalette } from "../command-palette";
import EngagementToaster from "../engagement-ui/EngagementToaster";
import JourneyWelcome from "../engagement-ui/JourneyWelcome";
import HandlePrompt from "../profiles/HandlePrompt";
import BottomNav from "./BottomNav";
import LegacyPageFrame from "./LegacyPageFrame";
import MoreSheet from "./MoreSheet";
import { applyMotionPreference } from "./motionPreference";
import { prefersReducedMotion } from "./motionQuery";
import {
  buildShellNav,
  getShellDocumentTitle,
  getShellPageMode,
  isFlushPage,
  WORKSPACE_LEARN,
  WORKSPACES,
} from "./navConfig";
import ShellHeader from "./ShellHeader";
import ShellSideNav from "./ShellSideNav";
import FeatureBoundary from "./ui/FeatureBoundary";
import PageSkeleton from "./ui/PageSkeleton";
import { ToastProvider } from "./ui/toast";
import { useBreakpoint } from "./useBreakpoint";
import { useDocumentChrome } from "./useDocumentChrome";
import { useNavSignals } from "./useNavSignals";
import { useSideNavCollapsed } from "./useSideNavCollapsed";

/** Route key for the page entrance: tab switches inside one page do not replay it. */
function entranceKey(nav, pathname) {
  const parent = String(pathname || "").replace(/\/[^/]*\/?$/, "");
  return `${nav.activeItem?.id || ""}|${parent}`;
}

/**
 * M1 (fallback M1c): the new page fades in and rises 8 px (moderate-01,
 * entrance-productive, +40 ms). Header and navs never move. Transform and
 * opacity only; nothing under reduced motion.
 */
function usePageEntrance(ref, key) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = ref.current;
    if (!node || typeof node.animate !== "function" || prefersReducedMotion()) return;
    node.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 150, delay: 40, easing: "cubic-bezier(0, 0, 0.38, 0.9)", fill: "backwards" }
    );
  }, [ref, key]);
}

/**
 * The Console shell (plan §3.1) for every signed-in route. Lazily loaded so
 * Carbon never ships with the public website.
 *
 * Desktop (≥ 1056 px): 48 px header, side nav (232 px or a 64 px rail).
 * Phones/tablets: header, bottom tab bar (4 + More) and the More sheet.
 * Focus mode (player, live room, host studio): rail, no tab bar, back arrow.
 */
export default function AppShellLayout() {
  const auth = useAuth();
  const { user, isAdmin, logout } = auth;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDesktop } = useBreakpoint();
  const { caps } = useCapabilities();
  const [moreOpen, setMoreOpen] = useState(false);
  const [sideNavCollapsed, toggleSideNav] = useSideNavCollapsed();
  const moreButtonRef = useRef(null);
  const pageRef = useRef(null);
  const backOfficeUrl = isAdmin ? resolveDjangoAdminUrl() : "";

  // The workspace decides whether the Learn hints are worth a request.
  const baseNav = useMemo(
    () => buildShellNav(auth, { pathname, caps, brandId: siteBrand.id, backOfficeUrl }),
    [auth, pathname, caps, backOfficeUrl]
  );
  const signals = useNavSignals({ userId: user?.id ?? null, enabled: baseNav.workspace === WORKSPACE_LEARN });
  const nav = useMemo(
    () =>
      signals.guidesAvailable
        ? baseNav
        : buildShellNav(auth, { pathname, caps, brandId: siteBrand.id, backOfficeUrl, guidesAvailable: false }),
    [auth, pathname, caps, backOfficeUrl, baseNav, signals.guidesAvailable]
  );

  useEffect(() => {
    applyMotionPreference();
  }, []);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname, isDesktop]);

  useDocumentChrome(getShellDocumentTitle(nav));
  usePageEntrance(pageRef, entranceKey(nav, pathname));

  const closeMore = useCallback(() => setMoreOpen(false), []);
  const handleSignOut = useCallback(async () => {
    setMoreOpen(false);
    try {
      await logout();
    } finally {
      navigate("/login");
    }
  }, [logout, navigate]);
  const handleWorkspaceChange = useCallback(
    (key) => {
      const option = nav.workspaces.find((entry) => entry.key === key);
      if (option && option.state === "enabled") navigate(option.to || WORKSPACES[key]?.home || "/console");
    },
    [nav.workspaces, navigate]
  );
  const openPalette = useCallback(() => {
    setMoreOpen(false);
    openCommandPalette();
  }, []);

  const pageMode = getShellPageMode(pathname);
  const focus = nav.focus;
  const homePath = WORKSPACES[nav.workspace]?.home || "/console";
  // A crashing page shows a message inside the shell (navigation keeps
  // working) instead of unmounting the whole app; navigating away resets it.
  const page = (
    <FeatureBoundary label="This page" resetKeys={[pathname]}>
      <Outlet />
    </FeatureBoundary>
  );

  return (
    <div
      className="cds-app"
      data-shell-layout={isDesktop ? "desktop" : "mobile"}
      data-sidenav={isDesktop && (sideNavCollapsed || focus) ? "rail" : undefined}
      data-focus={focus ? "true" : undefined}
      data-workspace={nav.workspace}
    >
      <ToastProvider>
        <ShellHeader
          nav={nav}
          user={user}
          isDesktop={isDesktop}
          homePath={homePath}
          backOfficeUrl={backOfficeUrl}
          onOpenPalette={openPalette}
          onSignOut={handleSignOut}
        />
        {isDesktop ? (
          <ShellSideNav
            nav={nav}
            collapsed={sideNavCollapsed}
            forcedRail={focus}
            onToggleCollapsed={toggleSideNav}
            onWorkspaceChange={handleWorkspaceChange}
            signals={signals}
          />
        ) : null}
        <main id="main-content" className="cds-app__main" tabIndex={-1}>
          <Suspense
            fallback={
              <div className="cds-page">
                <PageSkeleton label="Loading page" />
              </div>
            }
          >
            {pageMode === "carbon" ? (
              <div ref={pageRef} className={isFlushPage(pathname) ? "cds-page cds-page--flush" : "cds-page"}>
                {page}
              </div>
            ) : (
              <div ref={pageRef}>
                <LegacyPageFrame>{page}</LegacyPageFrame>
              </div>
            )}
          </Suspense>
        </main>
        {!isDesktop && !focus ? (
          <BottomNav
            ref={moreButtonRef}
            items={nav.bottomItems}
            activeId={nav.activeItem?.id || ""}
            moreActive={Boolean(nav.activeItem) && !nav.bottomItems.some((item) => item.id === nav.activeItem.id)}
            moreOpen={moreOpen}
            onMoreClick={() => setMoreOpen((value) => !value)}
            onAction={(action) => {
              if (action === "palette") openPalette();
            }}
            signals={signals}
          />
        ) : null}
        {!isDesktop && moreOpen ? (
          <MoreSheet
            nav={nav}
            user={user}
            pathname={pathname}
            signals={signals}
            backOfficeUrl={backOfficeUrl}
            onSignOut={handleSignOut}
            onClose={closeMore}
            onWorkspaceChange={handleWorkspaceChange}
            returnFocusRef={moreButtonRef}
          />
        ) : null}
        <CommandPalette />
        {/* One-time "Your journey so far" for students who studied here before release day.
            Rendered before the other once-only dialogs: it claims the screen first (dialogQueue). */}
        <JourneyWelcome />
        {/* "+20 XP" toasts from the X-Engagement header (renders nothing while the switch is off). */}
        <EngagementToaster />
        {/* One-time "choose your handle" prompt for students with an automatic handle. */}
        <HandlePrompt />
      </ToastProvider>
    </div>
  );
}
