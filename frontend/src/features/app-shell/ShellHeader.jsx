import { ArrowLeft, Search } from "@carbon/icons-react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import NotificationBell from "../../components/NotificationBell";
import { siteBrand } from "../../config/siteBrand";
import AccountMenu from "./AccountMenu";
import { CONSOLE_TITLE } from "./navConfig";
import ShellBrand from "./ShellBrand";

function isApplePlatform() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Desktop breadcrumb: "Admin / Grading" (plan §3.1). */
function Breadcrumbs({ items }) {
  if (!items?.length) return null;
  return (
    <nav className="cds-app-header__crumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((crumb, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${crumb.label}-${index}`}>
              {crumb.to ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** "Jump to… Ctrl K": a field-shaped button on desktop, a search icon on phones. */
function PaletteTrigger({ compact, onOpen }) {
  const shortcut = useMemo(() => (isApplePlatform() ? "⌘K" : "Ctrl K"), []);
  if (compact) {
    return (
      <button type="button" className="cds-app-icon-button" aria-label="Jump to" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen}>
        <Search size={20} aria-hidden="true" />
      </button>
    );
  }
  return (
    <button type="button" className="cds-app-jump" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen}>
      <Search size={16} aria-hidden="true" className="cds-app-jump__icon" />
      <span className="cds-app-jump__label">Jump to…</span>
      <kbd className="cds-app-jump__kbd" aria-hidden="true">
        {shortcut}
      </kbd>
      <span className="cds--visually-hidden"> ({shortcut})</span>
    </button>
  );
}

/**
 * Console header, 48 px (plan §3.1). Left: brand (links to the public
 * website's home page) and the breadcrumb on desktop; on phones, deeper pages and focus
 * mode show a back arrow with the page title instead. Right: Jump to…
 * (command palette), the notifications bell and the avatar menu.
 */
export default function ShellHeader({ nav, user, isDesktop, backOfficeUrl, onOpenPalette, onSignOut }) {
  const showBack = nav.focus || (!isDesktop && !nav.isRoot);
  return (
    <header className="cds-app-header" aria-label={`${siteBrand.name} ${CONSOLE_TITLE}`}>
      <a className="cds-app-skip" href="#main-content">
        Skip to main content
      </a>
      <div className="cds-app-header__start">
        {showBack ? (
          <Link className="cds-app-icon-button cds-app-header__back" to={nav.backTo} aria-label={`Back to ${nav.backLabel || "previous page"}`}>
            <ArrowLeft size={20} aria-hidden="true" />
          </Link>
        ) : null}
        {showBack && !isDesktop ? (
          <span className="cds-app-header__title">{nav.title}</span>
        ) : (
          <>
            <Link className="cds-app-header__brand" to="/" aria-label={`${siteBrand.name}: back to the website home page`}>
              <ShellBrand />
            </Link>
            {isDesktop ? <Breadcrumbs items={nav.breadcrumbs} /> : null}
          </>
        )}
      </div>
      <div className="cds-app-header__end">
        <PaletteTrigger compact={!isDesktop} onOpen={onOpenPalette} />
        <NotificationBell variant="console" />
        <AccountMenu user={user} backOfficeUrl={backOfficeUrl} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
