import { Launch } from "@carbon/icons-react";
import { Link } from "react-router-dom";
import { getNavIcon } from "./navIcons";
import { isExternalNavItem, isNavItemActive } from "./navConfig";

/** Icon + label rows used by the account panel and the phone "More" sheet. */
export default function NavActionList({ items, pathname, onNavigate, label }) {
  return (
    <ul className="cds-app-action-list" aria-label={label}>
      {items.map((item) => {
        const Icon = getNavIcon(item.icon);
        if (isExternalNavItem(item)) {
          return (
            <li key={item.id}>
              <a
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className="cds-app-action-list__item"
                data-external="true"
                onClick={onNavigate}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{item.label}</span>
                <Launch size={16} aria-hidden="true" className="cds-app-action-list__external" />
                <span className="cds--visually-hidden"> (opens in a new tab)</span>
              </a>
            </li>
          );
        }
        const active = isNavItemActive(item, pathname);
        return (
          <li key={item.id}>
            <Link
              to={item.to}
              className="cds-app-action-list__item"
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
