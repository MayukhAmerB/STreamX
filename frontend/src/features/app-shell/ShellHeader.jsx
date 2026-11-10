import {
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderName,
  HeaderPanel,
  SkipToContent,
} from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { siteBrand } from "../../config/siteBrand";
import NavActionList from "./NavActionList";
import SignOutButton from "./SignOutButton";
import ThemeSwitcher from "./ThemeSwitcher";
import UserAvatar from "./UserAvatar";
import { useDismiss } from "./useDismiss";

const ACCOUNT_PANEL_ID = "cds-app-account-panel";

/**
 * Carbon UI Shell header: product name, and an avatar button that opens the
 * account panel (profile links, appearance, sign out).
 */
export default function ShellHeader({ user, accountItems, themePreference, onThemeChange, onSignOut }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const { pathname } = useLocation();
  const dismissRefs = useMemo(() => [triggerRef, panelRef], []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useDismiss({ open, refs: dismissRefs, onDismiss: close, returnFocusRef: triggerRef });

  const displayName = user?.full_name || "Your account";

  return (
    <Header aria-label={siteBrand.name}>
      <SkipToContent href="#main-content">Skip to main content</SkipToContent>
      <HeaderName as={Link} to="/my-courses" prefix="">
        <img className="cds-app-header__brand-mark" src="/logo.jpeg" alt="" aria-hidden="true" />
        {siteBrand.name}
      </HeaderName>
      <HeaderGlobalBar>
        <HeaderGlobalAction
          ref={triggerRef}
          aria-label="Account and settings"
          aria-expanded={open}
          aria-controls={ACCOUNT_PANEL_ID}
          isActive={open}
          tooltipAlignment="end"
          onClick={() => setOpen((value) => !value)}
        >
          <UserAvatar user={user} />
        </HeaderGlobalAction>
      </HeaderGlobalBar>
      <HeaderPanel
        ref={panelRef}
        id={ACCOUNT_PANEL_ID}
        className="cds-app-account-panel"
        expanded={open}
        addFocusListeners={false}
        aria-label="Account and settings"
      >
        {open ? (
          <>
            <div className="cds-app-account-panel__user">
              <UserAvatar user={user} size="lg" />
              <div style={{ minWidth: 0 }}>
                <div className="cds-app-account-panel__name">{displayName}</div>
                {user?.email ? <div className="cds-app-account-panel__email">{user.email}</div> : null}
              </div>
            </div>
            <NavActionList items={accountItems} pathname={pathname} onNavigate={close} label="Account" />
            <div className="cds-app-account-panel__section">
              <ThemeSwitcher value={themePreference} onChange={onThemeChange} />
            </div>
            <SignOutButton onSignOut={onSignOut} />
          </>
        ) : null}
      </HeaderPanel>
    </Header>
  );
}
