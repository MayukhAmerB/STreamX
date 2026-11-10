import "./styles/carbon-app.scss";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import { useAuth } from "../../hooks/useAuth";
import { resolveDjangoAdminUrl } from "../../utils/backendUrl";
import BottomNav from "./BottomNav";
import LegacyPageFrame from "./LegacyPageFrame";
import MoreSheet from "./MoreSheet";
import {
  getBottomNavItems,
  getMoreItems,
  getNavItems,
  getNavSections,
  getShellDocumentTitle,
  getShellPageMode,
  isFlushPage,
  isMoreActive,
  NAV_SECTIONS,
} from "./navConfig";
import ShellHeader from "./ShellHeader";
import ShellSideNav from "./ShellSideNav";
import PageSkeleton from "./ui/PageSkeleton";
import { ToastProvider } from "./ui/toast";
import { useBreakpoint } from "./useBreakpoint";
import { useDocumentChrome } from "./useDocumentChrome";
import { useLastCourseId } from "./useLastCourseId";
import { useSideNavCollapsed } from "./useSideNavCollapsed";

function groupMoreItems(items) {
  return NAV_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    items: items.filter((item) => item.section === section.id),
  })).filter((group) => group.items.length > 0);
}

/**
 * "Console": the Carbon app shell for every functional (logged-in)
 * route, styled like the public landing page (black, Inter, champagne
 * accent). Lazily loaded, so Carbon's JS and CSS never ship with the public
 * website bundle.
 *
 * Desktop (>= 1056px): Header + persistent SideNav.
 * Phones/tablets: compact Header + bottom tab bar + "More" sheet.
 */
export default function AppShellLayout() {
  const auth = useAuth();
  const { user, isAdmin, logout } = auth;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isDesktop } = useBreakpoint();
  const lastCourseId = useLastCourseId(pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const [sideNavCollapsed, toggleSideNav] = useSideNavCollapsed();
  const moreButtonRef = useRef(null);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname, isDesktop]);

  const navOptions = useMemo(() => ({ lastCourseId, brandId: siteBrand.id }), [lastCourseId]);
  const navItems = useMemo(() => getNavItems(auth, navOptions), [auth, navOptions]);
  const sections = useMemo(() => getNavSections(auth, navOptions), [auth, navOptions]);
  const bottomItems = useMemo(() => getBottomNavItems(navItems), [navItems]);
  const moreGroups = useMemo(() => groupMoreItems(getMoreItems(navItems)), [navItems]);
  const accountItems = useMemo(() => navItems.filter((item) => item.section === "account"), [navItems]);
  const adminConsoleUrl = isAdmin ? resolveDjangoAdminUrl() : "";

  useDocumentChrome(getShellDocumentTitle(navItems, pathname));

  const closeMore = useCallback(() => setMoreOpen(false), []);
  const handleSignOut = useCallback(async () => {
    setMoreOpen(false);
    try {
      await logout();
    } finally {
      navigate("/login");
    }
  }, [logout, navigate]);

  const pageMode = getShellPageMode(pathname);
  const page = <Outlet />;

  return (
    <div
      className="cds-app"
      data-shell-layout={isDesktop ? "desktop" : "mobile"}
      data-sidenav={isDesktop && sideNavCollapsed ? "rail" : undefined}
    >
      <ToastProvider>
        <ShellHeader
          user={user}
          accountItems={accountItems}
          onSignOut={handleSignOut}
        />
        {isDesktop ? (
          <ShellSideNav
            sections={sections}
            pathname={pathname}
            adminConsoleUrl={adminConsoleUrl}
            collapsed={sideNavCollapsed}
            onToggleCollapsed={toggleSideNav}
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
              <div className={isFlushPage(pathname) ? "cds-page cds-page--flush" : "cds-page"}>{page}</div>
            ) : (
              <LegacyPageFrame>{page}</LegacyPageFrame>
            )}
          </Suspense>
        </main>
        {!isDesktop ? (
          <BottomNav
            ref={moreButtonRef}
            items={bottomItems}
            pathname={pathname}
            moreActive={isMoreActive(navItems, pathname)}
            moreOpen={moreOpen}
            onMoreClick={() => setMoreOpen((value) => !value)}
          />
        ) : null}
        {!isDesktop && moreOpen ? (
          <MoreSheet
            groups={moreGroups}
            pathname={pathname}
            onSignOut={handleSignOut}
            onClose={closeMore}
            returnFocusRef={moreButtonRef}
          />
        ) : null}
      </ToastProvider>
    </div>
  );
}
