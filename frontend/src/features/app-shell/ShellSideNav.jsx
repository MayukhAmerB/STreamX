import { Launch, SidePanelClose, SidePanelOpen } from "@carbon/icons-react";
import { SideNav, SideNavItems, SideNavLink } from "@carbon/react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { getNavIcon } from "./navIcons";
import { CONSOLE_TITLE, isExternalNavItem, isNavItemActive } from "./navConfig";

export const SIDE_NAV_ID = "cds-app-side-nav";

/** Label + "opens in a new tab" cue for links that leave the Console. */
function ExternalLabel({ label }) {
  return (
    <>
      {label}
      <Launch size={14} className="cds-app-sidenav__external" aria-hidden="true" />
      <span className="cds--visually-hidden"> (opens in a new tab)</span>
    </>
  );
}

/**
 * Persistent desktop side navigation for the Console (Carbon UI Shell
 * SideNav, >= lg): grouped sections with micro-labels, a champagne active
 * item, and an optional collapsed icon rail (the choice is remembered per
 * viewer by the layout).
 */
export default function ShellSideNav({ sections, pathname, adminConsoleUrl, collapsed = false, onToggleCollapsed }) {
  // In the icon rail the visible label is hidden, so the native tooltip names the item.
  const railTitle = (label) => (collapsed ? label : undefined);
  return (
    <SideNav
      id={SIDE_NAV_ID}
      aria-label="Main navigation"
      className={`cds-app-sidenav${collapsed ? " cds-app-sidenav--rail" : ""}`}
      expanded
      isPersistent
      addFocusListeners={false}
      addMouseListeners={false}
    >
      <SideNavItems>
        <li className="cds-app-sidenav__title">{CONSOLE_TITLE}</li>
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.label ? (
              <li className="cds-app-sidenav__heading">
                <span className="cds-app-sidenav__heading-text">{section.label}</span>
              </li>
            ) : null}
            {section.items.map((item) => {
              if (isExternalNavItem(item)) {
                return (
                  <SideNavLink
                    key={item.id}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    renderIcon={getNavIcon(item.icon)}
                    title={railTitle(`${item.label} (opens in a new tab)`)}
                    data-external="true"
                  >
                    <ExternalLabel label={item.label} />
                  </SideNavLink>
                );
              }
              const active = isNavItemActive(item, pathname);
              return (
                <SideNavLink
                  key={item.id}
                  as={Link}
                  to={item.to}
                  renderIcon={getNavIcon(item.icon)}
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                  title={railTitle(item.label)}
                >
                  {item.label}
                </SideNavLink>
              );
            })}
          </Fragment>
        ))}
        {adminConsoleUrl ? (
          <SideNavLink
            href={adminConsoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            renderIcon={Launch}
            title={railTitle("Admin console (opens in a new tab)")}
          >
            Admin console
            <span className="cds--visually-hidden"> (opens in a new tab)</span>
          </SideNavLink>
        ) : null}
      </SideNavItems>
      {onToggleCollapsed ? (
        <div className="cds-app-sidenav__footer">
          <button
            type="button"
            className="cds-app-sidenav__toggle"
            aria-controls={SIDE_NAV_ID}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand menu" : undefined}
            onClick={onToggleCollapsed}
          >
            {collapsed ? (
              <SidePanelOpen size={20} aria-hidden="true" />
            ) : (
              <SidePanelClose size={20} aria-hidden="true" />
            )}
            <span className="cds-app-sidenav__toggle-label">{collapsed ? "Expand menu" : "Collapse menu"}</span>
          </button>
        </div>
      ) : null}
    </SideNav>
  );
}
