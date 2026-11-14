import { AccessibilityAlt, Earth, Launch } from "@carbon/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useMotionPreference } from "./motionPreference";
import { ACCOUNT_ITEMS } from "./navConfig";
import { getNavIcon } from "./navIcons";
import SignOutButton from "./SignOutButton";
import MyCosmeticName from "../monthly-ctf/MyCosmeticName";
import UserAvatar from "./UserAvatar";
import { useDismiss } from "./useDismiss";

/** "Reduce motion" as a switch row (role="switch", ≥44 px target). */
export function MotionToggleRow() {
  const [reduced, setReduced] = useMotionPreference();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={reduced}
      className="cds-app-nav-row cds-app-nav-row--switch"
      onClick={() => setReduced(!reduced)}
    >
      <AccessibilityAlt size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
      <span className="cds-app-nav-row__label">Reduce motion</span>
      <span className={`cds-app-switch${reduced ? " is-on" : ""}`} aria-hidden="true">
        <span className="cds-app-switch__knob" />
      </span>
    </button>
  );
}

/**
 * Avatar menu in the header (plan §3.1): Profile, ID card, Reduce motion,
 * Website, Back office (staff) and Sign out. A disclosure panel: Esc or a
 * press outside closes it and focus returns to the avatar.
 */
export default function AccountMenu({ user, backOfficeUrl = "", onSignOut }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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
    <div className="cds-app-account">
      <button
        ref={triggerRef}
        type="button"
        className={`cds-app-icon-button cds-app-account__trigger${open ? " is-open" : ""}`}
        aria-label="Account and settings"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <UserAvatar user={user} animated />
      </button>
      <div ref={panelRef} id={panelId} className="cds-app-popover cds-app-account__panel" hidden={!open} aria-label="Account and settings" role="region">
        {open ? (
          <>
            <div className="cds-app-account__user">
              <UserAvatar user={user} size="lg" />
              <div className="cds-app-account__text">
                <span className="cds-app-account__name">
                  <MyCosmeticName user={user}>{displayName}</MyCosmeticName>
                </span>
                {user?.email ? <span className="cds-app-account__email">{user.email}</span> : null}
              </div>
            </div>
            <ul className="cds-app-account__list" aria-label="Account">
              {ACCOUNT_ITEMS.map((item) => {
                const Icon = getNavIcon(item.icon);
                const active = item.match.some((pattern) => pattern.test(pathname));
                return (
                  <li key={item.id}>
                    <Link className="cds-app-nav-row" to={item.to} aria-current={active ? "page" : undefined} onClick={close}>
                      <Icon size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
                      <span className="cds-app-nav-row__label">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
              <li>
                <MotionToggleRow />
              </li>
            </ul>
            <ul className="cds-app-account__list" aria-label="Leave the Console">
              <li>
                <Link className="cds-app-nav-row" to="/" onClick={close}>
                  <Earth size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
                  <span className="cds-app-nav-row__label">Website</span>
                </Link>
              </li>
              {backOfficeUrl ? (
                <li>
                  <a className="cds-app-nav-row" href={backOfficeUrl} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <Launch size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
                    <span className="cds-app-nav-row__label">Back office</span>
                    <span className="cds--visually-hidden"> (opens in a new tab)</span>
                  </a>
                </li>
              ) : null}
              <li>
                <SignOutButton onSignOut={onSignOut} />
              </li>
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
