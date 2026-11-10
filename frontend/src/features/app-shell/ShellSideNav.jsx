import { Launch } from "@carbon/icons-react";
import { SideNav, SideNavItems, SideNavLink } from "@carbon/react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { getNavIcon } from "./navIcons";
import { isNavItemActive, USERS_CORNER_TITLE } from "./navConfig";

/** Persistent desktop side navigation for User's Corner (Carbon UI Shell SideNav, >= lg). */
export default function ShellSideNav({ sections, pathname, adminConsoleUrl }) {
  return (
    <SideNav
      aria-label="Main navigation"
      className="cds-app-sidenav"
      expanded
      isPersistent
      addFocusListeners={false}
      addMouseListeners={false}
    >
      <SideNavItems>
        <li className="cds-app-sidenav__title">{USERS_CORNER_TITLE}</li>
        {sections.map((section) => (
          <Fragment key={section.id}>
            {section.label ? <li className="cds-app-sidenav__heading">{section.label}</li> : null}
            {section.items.map((item) => {
              const active = isNavItemActive(item, pathname);
              return (
                <SideNavLink
                  key={item.id}
                  as={Link}
                  to={item.to}
                  renderIcon={getNavIcon(item.icon)}
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </SideNavLink>
              );
            })}
          </Fragment>
        ))}
        {adminConsoleUrl ? (
          <SideNavLink href={adminConsoleUrl} target="_blank" rel="noreferrer" renderIcon={Launch}>
            Admin console
          </SideNavLink>
        ) : null}
      </SideNavItems>
    </SideNav>
  );
}
