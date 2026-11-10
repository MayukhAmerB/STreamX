import { Close } from "@carbon/icons-react";
import { IconButton } from "@carbon/react";
import { useEffect, useId, useMemo, useRef } from "react";
import { MORE_SHEET_ID } from "./BottomNav";
import NavActionList from "./NavActionList";
import SignOutButton from "./SignOutButton";
import ThemeSwitcher from "./ThemeSwitcher";
import { useDismiss } from "./useDismiss";

function trapTab(event, container) {
  if (event.key !== "Tab" || !container) return;
  const focusable = container.querySelectorAll(
    'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
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

/**
 * Phone "More" bottom sheet: secondary destinations, appearance and sign out.
 * Modal dialog semantics: focus moves in, Tab is trapped, Escape / scrim tap
 * closes and focus returns to the More button.
 */
export default function MoreSheet({
  groups,
  pathname,
  themePreference,
  onThemeChange,
  onSignOut,
  onClose,
  returnFocusRef,
}) {
  const titleId = useId();
  const panelRef = useRef(null);
  const dismissRefs = useMemo(() => [panelRef, returnFocusRef], [returnFocusRef]);

  useDismiss({ open: true, refs: dismissRefs, onDismiss: onClose, returnFocusRef });

  useEffect(() => {
    panelRef.current?.focus();
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div className="cds-app-sheet">
      <div className="cds-app-sheet__scrim" aria-hidden="true" />
      <div
        ref={panelRef}
        id={MORE_SHEET_ID}
        className="cds-app-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => trapTab(event, panelRef.current)}
      >
        <div className="cds-app-sheet__header">
          <h2 id={titleId} className="cds-app-sheet__title">
            More
          </h2>
          <IconButton
            kind="ghost"
            size="lg"
            label="Close"
            align="left"
            onClick={() => {
              onClose();
              returnFocusRef?.current?.focus?.();
            }}
          >
            <Close size={20} />
          </IconButton>
        </div>
        <div className="cds-app-sheet__body">
          {groups.map((group) => (
            <div key={group.id} className="cds-app-sheet__group">
              {group.label ? <span className="cds-app-sheet__group-label">{group.label}</span> : null}
              <NavActionList items={group.items} pathname={pathname} onNavigate={onClose} label={group.label || "More"} />
            </div>
          ))}
          <div className="cds-app-sheet__section">
            <ThemeSwitcher value={themePreference} onChange={onThemeChange} />
          </div>
          <div className="cds-app-sheet__group">
            <SignOutButton onSignOut={onSignOut} />
          </div>
        </div>
      </div>
    </div>
  );
}
