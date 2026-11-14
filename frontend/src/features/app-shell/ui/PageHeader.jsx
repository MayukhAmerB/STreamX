// PageHeader v2 (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// Breadcrumbs, a plain task-name title (Plex 400 32/40), at most one line of
// description, at most one primary and one secondary action, and an
// overflow menu for the rest. No "— CONSOLE" eyebrow and no glow: pass
// `eyebrow` only for a real context line (it gets the champagne rule).
import { OverflowMenuVertical } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

const isExternal = (href) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/admin\/)/i.test(String(href || ""));

function ActionButton({ action, kind }) {
  if (!action) return null;
  const { label, href, onClick, accent, icon: Icon, disabled } = action;
  const className = accent ? "sc-button--accent" : undefined;
  const resolvedKind = accent ? "primary" : kind;
  const common = { kind: resolvedKind, className, renderIcon: Icon, disabled };
  if (href && isExternal(href)) {
    return (
      <Button {...common} href={href}>
        {label}
      </Button>
    );
  }
  if (href) {
    return (
      <Button {...common} as={Link} to={href}>
        {label}
      </Button>
    );
  }
  return (
    <Button {...common} onClick={onClick}>
      {label}
    </Button>
  );
}

/** "More actions" menu: a plain disclosure (M11 menu motion), Esc and outside click close it. */
function OverflowActions({ actions }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrapper = useRef(null);
  const trigger = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus?.();
      }
    };
    const onPointer = (event) => {
      if (!wrapper.current?.contains?.(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  if (!actions?.length) return null;
  return (
    <div className="sc-overflow" ref={wrapper}>
      <button
        ref={trigger}
        type="button"
        className="sc-overflow__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More actions"
        onClick={() => setOpen((value) => !value)}
      >
        <OverflowMenuVertical size={20} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={menuId} className="sc-overflow__menu">
          {actions.map((action) => (
            <li key={action.label}>
              {action.href ? (
                isExternal(action.href) ? (
                  <a className={`sc-overflow__item${action.danger ? " sc-overflow__item--danger" : ""}`} href={action.href}>
                    {action.label}
                  </a>
                ) : (
                  <Link className={`sc-overflow__item${action.danger ? " sc-overflow__item--danger" : ""}`} to={action.href} onClick={() => setOpen(false)}>
                    {action.label}
                  </Link>
                )
              ) : (
                <button
                  type="button"
                  className={`sc-overflow__item${action.danger ? " sc-overflow__item--danger" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    action.onClick?.();
                  }}
                >
                  {action.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Page header: breadcrumbs, title, one-line description and actions.
 * `actions` (legacy) is any node, usually one Carbon <Button>.
 * v2: `primaryAction` / `secondaryAction` {label, onClick|href, accent?, icon?},
 * `overflowActions` [{label, onClick|href, danger?}].
 */
export default function PageHeader({
  title,
  description,
  actions,
  eyebrow = null,
  breadcrumbs,
  primaryAction,
  secondaryAction,
  overflowActions,
}) {
  const hasActions = actions || primaryAction || secondaryAction || overflowActions?.length;
  return (
    <header className="cds-page-header">
      <div className="cds-page-header__text">
        {breadcrumbs?.length ? (
          <nav aria-label="Breadcrumb" className="cds-page-header__breadcrumbs">
            <ol>
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${crumb.href || index}`}>
                  {crumb.href && index < breadcrumbs.length - 1 ? (
                    <Link to={crumb.href}>{crumb.label}</Link>
                  ) : (
                    <span aria-current={index === breadcrumbs.length - 1 ? "page" : undefined}>{crumb.label}</span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        {eyebrow ? <p className="cds-page-header__eyebrow">{eyebrow}</p> : null}
        <h1 className="cds-page-header__title">{title}</h1>
        {description ? <p className="cds-page-header__description">{description}</p> : null}
      </div>
      {hasActions ? (
        <div className="cds-page-header__actions">
          {actions}
          <ActionButton action={secondaryAction} kind="tertiary" />
          <ActionButton action={primaryAction} kind="primary" />
          <OverflowActions actions={overflowActions} />
        </div>
      ) : null}
    </header>
  );
}
