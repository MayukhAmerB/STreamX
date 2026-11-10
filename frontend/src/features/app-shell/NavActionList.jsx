import { Link } from "react-router-dom";
import { getNavIcon } from "./navIcons";
import { isNavItemActive } from "./navConfig";

/** Icon + label rows used by the account panel and the phone "More" sheet. */
export default function NavActionList({ items, pathname, onNavigate, label }) {
  return (
    <ul className="cds-app-action-list" aria-label={label}>
      {items.map((item) => {
        const Icon = getNavIcon(item.icon);
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
