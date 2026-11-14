import { OverflowMenuHorizontal } from "@carbon/icons-react";
import { forwardRef, useEffect, useLayoutEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { LiveDot } from "../../site-kit/motion";
import { getNavIcon } from "./navIcons";

export const MORE_SHEET_ID = "cds-app-more-sheet";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function TabSignal({ item, signals }) {
  if (item.signal === "live" && signals?.live) {
    return (
      <span className="cds-app-bottom-nav__signal">
        <LiveDot state="live" />
        <span className="cds--visually-hidden"> (live now)</span>
      </span>
    );
  }
  if (item.signal === "coursework" && signals?.coursework) {
    return (
      <span className="cds-app-bottom-nav__signal">
        <span className="cds-app-nav-row__dot" aria-hidden="true" />
        <span className="cds--visually-hidden"> (something is due)</span>
      </span>
    );
  }
  return null;
}

/**
 * Accessible name of a tab: the full nav label when the short visible label
 * is part of it ("Work" → "Coursework", "Live" → "Live classes"), so screen
 * readers hear the destination while voice control still matches the
 * visible word (WCAG 2.5.3). Signals are appended in words.
 */
export function tabAccessibleName(item, signals) {
  const short = item.shortLabel || item.label;
  const full = item.label || short;
  const base = full !== short && full.toLowerCase().includes(short.toLowerCase()) ? full : null;
  if (!base) return undefined;
  if (item.signal === "live" && signals?.live) return `${base} (live now)`;
  if (item.signal === "coursework" && signals?.coursework) return `${base} (something is due)`;
  return base;
}

/**
 * Phone and tablet tab bar (< 1056 px, plan §3.1): four destinations plus
 * "More", 64 px + safe area. The current tab carries a 24×2 champagne bar
 * above its icon that slides between tabs (M13). An `action: "palette"` tab
 * (staff "Search") opens the command palette instead of navigating.
 */
const BottomNav = forwardRef(function BottomNav(
  { items, activeId, moreActive, moreOpen, onMoreClick, onAction, signals },
  moreButtonRef
) {
  const navRef = useRef(null);
  const indicatorRef = useRef(null);
  const activeIndex = moreOpen || moreActive ? items.length : items.findIndex((item) => item.id === activeId);

  useIsoLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const tabs = nav.querySelectorAll(".cds-app-bottom-nav__item");
    const tab = activeIndex >= 0 ? tabs[activeIndex] : null;
    if (!tab) {
      indicator.style.opacity = "0";
      return;
    }
    const center = tab.offsetLeft + tab.offsetWidth / 2;
    indicator.style.transform = `translateX(${Math.round(center - 12)}px)`;
    indicator.style.opacity = "1";
    if (!indicator.dataset.ready) {
      requestAnimationFrame(() => {
        if (indicatorRef.current) indicatorRef.current.dataset.ready = "true";
      });
    }
  }, [activeIndex, items.length]);

  return (
    <nav ref={navRef} className="cds-app-bottom-nav" aria-label="Main navigation">
      <span ref={indicatorRef} className="cds-app-bottom-nav__indicator" aria-hidden="true" />
      {items.map((item, index) => {
        const Icon = getNavIcon(item.icon);
        const active = index === activeIndex;
        const content = (
          <>
            <span className="cds-app-bottom-nav__icon">
              <Icon size={24} aria-hidden="true" />
              <TabSignal item={item} signals={signals} />
            </span>
            <span className="cds-app-bottom-nav__label">{item.shortLabel || item.label}</span>
          </>
        );
        if (item.action) {
          return (
            <button key={item.id} type="button" className="cds-app-bottom-nav__item" onClick={() => onAction?.(item.action)}>
              {content}
            </button>
          );
        }
        return (
          <Link
            key={item.id}
            to={item.to}
            className={`cds-app-bottom-nav__item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            aria-label={tabAccessibleName(item, signals)}
          >
            {content}
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
        <span className="cds-app-bottom-nav__icon">
          <OverflowMenuHorizontal size={24} aria-hidden="true" />
        </span>
        <span className="cds-app-bottom-nav__label">More</span>
      </button>
    </nav>
  );
});

export default BottomNav;
