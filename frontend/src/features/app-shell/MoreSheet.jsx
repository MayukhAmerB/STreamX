import { ChevronDown, Close, Earth, Launch } from "@carbon/icons-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MORE_SHEET_ID } from "./BottomNav";
import { prefersReducedMotion } from "./motionQuery";
import { ACCOUNT_ITEMS, WORKSPACE_ADMIN } from "./navConfig";
import { getNavIcon } from "./navIcons";
import { MotionToggleRow } from "./AccountMenu";
import SignOutButton from "./SignOutButton";
import { NavRow } from "./ShellSideNav";
import UserAvatar from "./UserAvatar";
import { useDismiss } from "./useDismiss";
import WorkspaceSwitch from "./WorkspaceSwitch";

const EXIT_MS = 150;
const SWIPE_CLOSE_PX = 80;

function trapTab(event, container) {
  if (event.key !== "Tab" || !container) return;
  const focusable = Array.from(
    container.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
  ).filter((node) => !node.closest("[hidden]"));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function SheetGroup({ section, open, onToggle, activeId, signals, onNavigate }) {
  const bodyId = useId();
  return (
    <div className="cds-app-sheet__group">
      <button type="button" className="cds-app-sheet__group-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(section.id)}>
        <span>{section.label}</span>
        <ChevronDown size={16} className="cds-app-sidenav__chevron" aria-hidden="true" />
      </button>
      <ul id={bodyId} hidden={!open} className="cds-app-sheet__list">
        {section.items.map((item) => (
          <li key={item.id}>
            <NavRow item={item} active={item.id === activeId} signals={signals} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Phone "More" sheet (plan §3.1, §3.2): the viewer first, then the
 * workspace switch, the rest of this workspace's destinations (each admin
 * group is one 56 px disclosure row; the current group starts open), and
 * the account rows. Max 85 vh, 56 px rows. Modal dialog:
 * focus moves in, Tab is trapped, Esc / scrim tap / swipe down closes with
 * an exit animation (M11) and focus returns to the More button.
 */
export default function MoreSheet({
  nav,
  user,
  pathname,
  signals,
  backOfficeUrl = "",
  onSignOut,
  onClose,
  onWorkspaceChange,
  returnFocusRef,
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef(null);
  const closeTimer = useRef(0);
  const activeId = nav.activeItem?.id || "";
  const activeSectionId = nav.activeSection?.id || "";
  const [openGroups, setOpenGroups] = useState(() => new Set(activeSectionId ? [activeSectionId] : []));
  const isAdmin = nav.workspace === WORKSPACE_ADMIN;

  const requestClose = useCallback(
    (restoreFocus = false) => {
      if (closing) return;
      const finish = () => {
        onClose();
        if (restoreFocus) returnFocusRef?.current?.focus?.();
      };
      if (prefersReducedMotion()) {
        finish();
        return;
      }
      setClosing(true);
      closeTimer.current = window.setTimeout(finish, EXIT_MS);
    },
    [closing, onClose, returnFocusRef]
  );

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const dismissRefs = useMemo(() => [panelRef, returnFocusRef], [returnFocusRef]);
  const dismiss = useCallback(() => requestClose(false), [requestClose]);
  useDismiss({ open: !closing, refs: dismissRefs, onDismiss: dismiss, returnFocusRef });

  useEffect(() => {
    panelRef.current?.focus();
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, []);

  const toggleGroup = (id) =>
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Swipe down on the grab area closes the sheet (transform only).
  const onPointerDown = (event) => {
    if (event.pointerType === "mouse") return;
    dragStart.current = event.clientY;
  };
  const onPointerMove = (event) => {
    if (dragStart.current === null) return;
    setDrag(Math.max(0, event.clientY - dragStart.current));
  };
  const onPointerEnd = () => {
    if (dragStart.current === null) return;
    dragStart.current = null;
    // Closing keeps the dragged offset so the exit continues from where the finger left it.
    if (drag > SWIPE_CLOSE_PX) requestClose(true);
    else setDrag(0);
  };

  const sections = nav.moreSections;
  const displayName = user?.full_name || user?.email || "Your account";

  return (
    <div className={`cds-app-sheet${closing ? " is-closing" : ""}`}>
      <div className="cds-app-sheet__scrim" aria-hidden="true" />
      <div
        ref={panelRef}
        id={MORE_SHEET_ID}
        className="cds-app-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={drag ? { transform: `translateY(${drag}px)`, transition: "none" } : undefined}
        onKeyDown={(event) => trapTab(event, panelRef.current)}
      >
        <div
          className="cds-app-sheet__header"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span className="cds-app-sheet__grab" aria-hidden="true" />
          <h2 id={titleId} className="cds--visually-hidden">
            More
          </h2>
          <div className="cds-app-sheet__user">
            <UserAvatar user={user} size="lg" />
            <div className="cds-app-sheet__user-text">
              <span className="cds-app-sheet__user-name">{displayName}</span>
              {user?.email && user?.full_name ? <span className="cds-app-sheet__user-email">{user.email}</span> : null}
            </div>
          </div>
          <button type="button" className="cds-app-icon-button" aria-label="Close" onClick={() => requestClose(true)}>
            <Close size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="cds-app-sheet__body">
          {nav.workspaces.length > 1 ? (
            <WorkspaceSwitch className="cds-app-sheet__workspace" options={nav.workspaces} value={nav.workspace} onChange={onWorkspaceChange} />
          ) : null}
          {sections.map((section) =>
            isAdmin ? (
              <SheetGroup
                key={section.id}
                section={section}
                open={openGroups.has(section.id)}
                onToggle={toggleGroup}
                activeId={activeId}
                signals={signals}
                onNavigate={() => onClose()}
              />
            ) : (
            <div key={section.id} className="cds-app-sheet__group">
              {section.label ? <h3 className="cds-app-sheet__group-label">{section.label}</h3> : null}
              <ul className="cds-app-sheet__list">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <NavRow item={item} active={item.id === activeId} signals={signals} onNavigate={() => onClose()} />
                  </li>
                ))}
              </ul>
            </div>
            )
          )}
          <div className="cds-app-sheet__group">
            <h3 className="cds-app-sheet__group-label">Account</h3>
            <ul className="cds-app-sheet__list" aria-label="Account">
              {ACCOUNT_ITEMS.map((item) => {
                const Icon = getNavIcon(item.icon);
                const active = item.match.some((pattern) => pattern.test(pathname));
                return (
                  <li key={item.id}>
                    <Link className="cds-app-nav-row" to={item.to} aria-current={active ? "page" : undefined} onClick={() => onClose()}>
                      <Icon size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
                      <span className="cds-app-nav-row__label">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
              <li>
                <MotionToggleRow />
              </li>
              <li>
                <Link className="cds-app-nav-row" to="/" onClick={() => onClose()}>
                  <Earth size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
                  <span className="cds-app-nav-row__label">Website</span>
                </Link>
              </li>
              {/* In the Admin workspace the back office is already a System row. */}
              {backOfficeUrl && nav.workspace !== WORKSPACE_ADMIN ? (
                <li>
                  <a className="cds-app-nav-row" href={backOfficeUrl} target="_blank" rel="noopener noreferrer" onClick={() => onClose()}>
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
          </div>
        </div>
      </div>
    </div>
  );
}
