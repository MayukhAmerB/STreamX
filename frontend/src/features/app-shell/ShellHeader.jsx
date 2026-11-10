import { ArrowLeft } from "@carbon/icons-react";
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
import { CONSOLE_PATH, CONSOLE_TITLE } from "./navConfig";
import ShellBrand from "./ShellBrand";
import SignOutButton from "./SignOutButton";
import UserAvatar from "./UserAvatar";
import { useDismiss } from "./useDismiss";

const ACCOUNT_PANEL_ID = "cds-app-account-panel";

/**
 * Carbon UI Shell header for the Console: the website's brand block (links
 * to the Console home), the section title, "Back to website", and an
 * avatar button that opens the account panel (profile links, sign out).
 */
export default function ShellHeader({ user, accountItems, onSignOut }) {
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
    <Header aria-label={`${siteBrand.name} ${CONSOLE_TITLE}`}>
      <SkipToContent href="#main-content">Skip to main content</SkipToContent>
      <HeaderName
        as={Link}
        to={CONSOLE_PATH}
        prefix=""
        className="uc-header__brand"
        aria-label={`${siteBrand.name}, ${CONSOLE_TITLE} home`}
      >
        <ShellBrand />
      </HeaderName>
      <span className="uc-header__section">{CONSOLE_TITLE}</span>
      <HeaderGlobalBar>
        <Link to="/" className="uc-header__back">
          <ArrowLeft size={20} aria-hidden="true" />
          <span className="uc-header__back-label">Back to website</span>
        </Link>
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
            <SignOutButton onSignOut={onSignOut} />
          </>
        ) : null}
      </HeaderPanel>
    </Header>
  );
}
