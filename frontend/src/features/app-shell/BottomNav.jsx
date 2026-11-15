import { OverflowMenuHorizontal } from "@carbon/icons-react";
import { forwardRef } from "react";
import { Link } from "react-router-dom";
import { getNavIcon } from "./navIcons";
import { isNavItemActive } from "./navConfig";

export const MORE_SHEET_ID = "cds-app-more-sheet";

/**
 * App-style tab bar for phones and tablets: up to four destinations plus
 * "More". Icon + short label, 64px tall, safe-area aware.
 */
const BottomNav = forwardRef(function BottomNav(
  { items, pathname, moreActive, moreOpen, onMoreClick },
  moreButtonRef
) {
  return (
    <nav className="cds-app-bottom-nav" aria-label="Main navigation">
      {items.map((item) => {
        const Icon = getNavIcon(item.icon);
        const active = isNavItemActive(item, pathname);
        return (
          <Link
            key={item.id}
            to={item.to}
            className={`cds-app-bottom-nav__item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon size={24} aria-hidden="true" />
            <span className="cds-app-bottom-nav__label">{item.shortLabel || item.label}</span>
          </Link>
        );
      })}
      <button
        ref={moreButtonRef}
        type="button"
        className={`cds-app-bottom-nav__item${moreActive || moreOpen ? " is-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        aria-controls={MORE_SHEET_ID}
        onClick={onMoreClick}
      >
        <OverflowMenuHorizontal size={24} aria-hidden="true" />
        <span className="cds-app-bottom-nav__label">More</span>
      </button>
    </nav>
  );
});

export default BottomNav;
