import "./Navbar.css";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { siteBrand } from "../config/siteBrand";
import { scrollToWatchSection } from "../features/youtube/watchAnchor";
import { useYouTubeChannel } from "../features/youtube/youTubeStore";
import { useAuth } from "../hooks/useAuth";
import { resolveDjangoAdminUrl } from "../utils/backendUrl";
import BrandLogo from "./BrandLogo";
import NotificationBell from "./NotificationBell";
import {
  getAccountMenuGroups,
  getInitials,
  getShortName,
  getSiteNavGroups,
  getSiteNavLinks,
  getWatchNavState,
  isSiteLinkActive,
  SITE_CONSOLE_PATH,
  WATCH_EMPTY_REASON,
} from "./siteNavModel";

const SCROLLED_AFTER_PX = 8;
const DESKTOP_QUERY = "(min-width: 1024px)";

function ChevronIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function ArrowIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M11.8 7.5 8.1 3.8l.7-.7L13.7 8l-4.9 4.9-.7-.7 3.7-3.7H2v-1z" />
    </svg>
  );
}

function ExternalIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="currentColor">
      <path d="M13 14H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h5v1H3v10h10V8h1v5a1 1 0 0 1-1 1z" />
      <path d="M10 1v1h3.3L9 6.3l.7.7L14 2.7V6h1V1z" />
    </svg>
  );
}

function ConsoleIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="square">
      <rect x="2" y="2.5" width="12" height="11" />
      <path d="M5 6.5 7 8l-2 1.5M8.5 10H11" />
    </svg>
  );
}

/** Live dot + "Live" next to "Watch", shown only while the channel is on air. */
function LiveIndicator() {
  return (
    <span className="snav__live">
      <span className="snav__live-dot" aria-hidden="true" />
      Live
    </span>
  );
}

/**
 * On the landing page "Watch" scrolls to the section (below the sticky
 * header); everywhere else, or if the section is hidden, it opens /watch.
 */
function watchClickHandler(pathname) {
  return (event) => {
    if (pathname === "/" && scrollToWatchSection()) {
      event.preventDefault();
    }
  };
}

/** Moves focus between the links of an open menu with the arrow keys. */
function handleMenuArrows(event, container) {
  if (!container || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...container.querySelectorAll("a[href], button:not([disabled])")];
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  let next = 0;
  if (event.key === "End") next = items.length - 1;
  else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
  else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
  items[next].focus();
}

/**
 * A disclosure dropdown that stays in the header's DOM (no portal):
 * Escape or a click outside closes it, focus returns to the trigger.
 */
function useDisclosure() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || panelRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onTriggerKeyDown = (event) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
    window.requestAnimationFrame(() => panelRef.current?.querySelector("a[href], button")?.focus());
  };

  return { open, setOpen, triggerRef, panelRef, onTriggerKeyDown };
}

function MenuLink({ link, className, onNavigate }) {
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className={className} onClick={onNavigate}>
        <span>{link.label}</span>
        <ExternalIcon className="snav__external" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <NavLink to={link.to} className={className} onClick={onNavigate}>
      <span>{link.label}</span>
    </NavLink>
  );
}

/**
 * "Watch" when the channel is configured but has nothing to play: a
 * focusable, non-navigating item whose reason is a tooltip (plan §7.2 rule 2).
 */
function DisabledWatchItem({ label, className }) {
  const reasonId = useId();
  return (
    <span
      className={`${className} is-disabled`}
      role="link"
      aria-disabled="true"
      tabIndex={0}
      aria-describedby={reasonId}
    >
      {label}
      <span id={reasonId} role="tooltip" className="snav__tooltip">
        {WATCH_EMPTY_REASON}
      </span>
    </span>
  );
}

function MoreMenu({ links, pathname }) {
  const menuId = useId();
  const { open, setOpen, triggerRef, panelRef, onTriggerKeyDown } = useDisclosure();
  const active = links.some((link) => isSiteLinkActive(link, pathname));

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  return (
    <li className="snav__more">
      <button
        ref={triggerRef}
        type="button"
        className={`snav__link snav__more-trigger${active ? " is-active" : ""}`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        More
        <ChevronIcon className={`snav__chevron${open ? " is-open" : ""}`} />
      </button>
      <div
        ref={panelRef}
        id={menuId}
        className="snav__menu snav__menu--more"
        hidden={!open}
        onKeyDown={(event) => handleMenuArrows(event, panelRef.current)}
      >
        <ul className="snav__menu-list">
          {links.map((link) => (
            <li key={link.id}>
              <MenuLink link={link} className="snav__menu-item" onNavigate={() => setOpen(false)} />
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function AccountMenu({ user, groups, onSignOut, pathname }) {
  const menuId = useId();
  const { open, setOpen, triggerRef, panelRef, onTriggerKeyDown } = useDisclosure();

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  return (
    <div className="snav__account">
      <button
        ref={triggerRef}
        type="button"
        className="snav__avatar-btn"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Account menu for ${user?.full_name || user?.email || "your account"}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="snav__avatar" aria-hidden="true">
          {getInitials(user)}
        </span>
        <span className="snav__avatar-name" aria-hidden="true">
          {getShortName(user)}
        </span>
        <ChevronIcon className={`snav__chevron${open ? " is-open" : ""}`} />
      </button>
      <div
        ref={panelRef}
        id={menuId}
        className="snav__menu snav__menu--account"
        hidden={!open}
        onKeyDown={(event) => handleMenuArrows(event, panelRef.current)}
      >
        <div className="snav__menu-user">
          <span className="snav__avatar snav__avatar--lg" aria-hidden="true">
            {getInitials(user)}
          </span>
          <span className="snav__menu-user-text">
            <span className="snav__menu-user-name">{user?.full_name || user?.email}</span>
            {user?.full_name && user?.email ? <span className="snav__menu-user-email">{user.email}</span> : null}
          </span>
        </div>
        {groups.map((group) => (
          <div key={group.id} className="snav__menu-group">
            <p className="snav__menu-label">{group.label}</p>
            <ul className="snav__menu-list">
              {group.links.map((link) => (
                <li key={link.id}>
                  <MenuLink link={link} className="snav__menu-item" onNavigate={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="snav__menu-group">
          <button type="button" className="snav__menu-item snav__menu-item--danger" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(event, container) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll(FOCUSABLE)];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** One row of the phone sheet. */
function SheetLink({ link, onClose, pathname, navigate, watchState }) {
  const reasonId = useId();
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="noopener noreferrer" className="snav-sheet__link" onClick={onClose}>
        <span>{link.label}</span>
        <ExternalIcon className="snav-sheet__arrow" />
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (link.id === "watch" && watchState === "disabled") {
    return (
      <span className="snav-sheet__link is-disabled" role="link" aria-disabled="true" tabIndex={0} aria-describedby={reasonId}>
        <span>{link.label}</span>
        <span id={reasonId} className="snav-sheet__reason">
          {WATCH_EMPTY_REASON}
        </span>
      </span>
    );
  }
  if (link.id === "watch") {
    return (
      <NavLink
        to={link.to}
        className="snav-sheet__link"
        onClick={(event) => {
          onClose();
          if (pathname === "/") {
            event.preventDefault();
            // Let the sheet unlock page scrolling first.
            window.requestAnimationFrame(() => {
              if (!scrollToWatchSection()) navigate(link.to);
            });
          }
        }}
      >
        <span className="snav-sheet__label-row">
          {link.label}
          {watchState === "live" ? <LiveIndicator /> : null}
        </span>
        <ArrowIcon className="snav-sheet__arrow" />
      </NavLink>
    );
  }
  return (
    <NavLink to={link.to} className="snav-sheet__link" onClick={onClose}>
      <span>{link.label}</span>
      <ArrowIcon className="snav-sheet__arrow" />
    </NavLink>
  );
}

/**
 * Phones and tablets (under 1024 px): a SideNav sheet. Modal dialog with a
 * focus trap, Escape and the scrim close it, focus returns to the menu button.
 */
function MobileSheet({ id, isAuthenticated, user, siteGroups, accountGroups, onSignOut, onClose, returnFocusRef, pathname, watchState }) {
  const panelRef = useRef(null);
  const titleId = useId();
  const navigate = useNavigate();

  useEffect(() => {
    panelRef.current?.focus();
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      onClose();
      returnFocusRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, returnFocusRef]);

  const close = () => {
    onClose();
    returnFocusRef.current?.focus();
  };

  return (
    <div className="snav-sheet-layer" data-theme="g100">
      <div className="snav-sheet__scrim" aria-hidden="true" onClick={close} />
      <div
        ref={panelRef}
        id={id}
        className="snav-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => trapTab(event, panelRef.current)}
      >
        <div className="snav-sheet__top">
          <BrandLogo className="snav__brand" variant="shell" showLabel={false} />
          <h2 id={titleId} className="sr-only">
            Site menu
          </h2>
          <button type="button" className="snav__icon-btn" aria-label="Close navigation menu" onClick={close}>
            <svg aria-hidden="true" viewBox="0 0 16 16" className="snav__icon" fill="currentColor">
              <path d="M12 4.7 11.3 4 8 7.3 4.7 4 4 4.7 7.3 8 4 11.3l.7.7L8 8.7l3.3 3.3.7-.7L8.7 8z" />
            </svg>
          </button>
        </div>

        <div className="snav-sheet__body">
          {isAuthenticated ? (
            <div className="snav-sheet__user">
              <span className="snav__avatar snav__avatar--lg" aria-hidden="true">
                {getInitials(user)}
              </span>
              <span className="snav__menu-user-text">
                <span className="snav__menu-user-name">{user?.full_name || user?.email}</span>
                {user?.full_name && user?.email ? <span className="snav__menu-user-email">{user.email}</span> : null}
              </span>
            </div>
          ) : null}

          <nav aria-label="Site">
            {siteGroups.map((group) => (
              <div key={group.id} className="snav-sheet__group">
                <p className="snav-sheet__label">{group.label}</p>
                <ul className="snav-sheet__list">
                  {group.links.map((link) => (
                    <li key={link.id}>
                      <SheetLink link={link} onClose={onClose} pathname={pathname} navigate={navigate} watchState={watchState} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          {isAuthenticated
            ? accountGroups.map((group) => (
                <div key={group.id} className="snav-sheet__group">
                  <p className="snav-sheet__label">{group.label}</p>
                  <ul className="snav-sheet__list">
                    {group.links.map((link) => (
                      <li key={link.id}>
                        <SheetLink link={link} onClose={onClose} pathname={pathname} navigate={navigate} watchState={watchState} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            : null}

          {isAuthenticated ? (
            <div className="snav-sheet__group">
              <button type="button" className="snav-sheet__link snav-sheet__link--danger" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>

        <div className="snav-sheet__footer">
          {isAuthenticated ? (
            <Link to={SITE_CONSOLE_PATH} className="snav__cta snav__cta--block" onClick={onClose}>
              Open Console
              <ConsoleIcon className="snav__icon" />
            </Link>
          ) : (
            <>
              <Link to="/courses" className="snav__cta snav__cta--block" onClick={onClose}>
                Browse courses
                <ArrowIcon className="snav__icon" />
              </Link>
              <Link to="/login" className="snav__ghost snav__ghost--block" onClick={onClose}>
                Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Website header (Syed Carbon UI shell, plan §7.3 band 0): a 48 px g100 bar,
 * brand at the left, the key links and "More" in the centre, actions at the
 * right (guests: Sign in + Browse courses; signed in: bell, Console, account
 * menu). Under 1024 px the links move into a SideNav sheet. The bar has one
 * height in every state, so anchors (scroll-padding-top) never end up under it.
 */
export default function Navbar() {
  const { user, isAuthenticated, isInstructor, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname } = location;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuButtonRef = useRef(null);
  const sheetId = useId();

  const youtube = useYouTubeChannel();
  const watchState = getWatchNavState({ brandHasYouTube: siteBrand.youtube, youtube });
  const navOptions = { youtube: watchState !== "hidden" };
  const isLive = watchState === "live";
  const { primary, more } = getSiteNavLinks(siteBrand.id, navOptions);
  const siteGroups = getSiteNavGroups(siteBrand.id, navOptions);
  const accountGroups = isAuthenticated
    ? getAccountMenuGroups({ isInstructor, isAdmin, djangoAdminUrl: isAdmin ? resolveDjangoAdminUrl() : "" })
    : [];

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > SCROLLED_AFTER_PX);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  // The sheet is for small screens only: close it when the window grows.
  useEffect(() => {
    if (!mobileMenuOpen || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (query.matches) setMobileMenuOpen(false);
    };
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, [mobileMenuOpen]);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  const onLogout = async () => {
    setMobileMenuOpen(false);
    await logout();
    navigate("/login");
  };

  return (
    <header
      className="snav"
      data-theme="g100"
      data-scrolled={scrolled ? "true" : "false"}
      data-menu-open={mobileMenuOpen ? "true" : "false"}
    >
      <div className="snav__bar">
        <BrandLogo className="snav__brand" variant="shell" />

        <nav className="snav__primary" aria-label="Main">
          <ul className="snav__pill">
            {primary.map((link) => (
              <li key={link.id}>
                {link.id === "watch" && watchState === "disabled" ? (
                  <DisabledWatchItem label={link.shortLabel || link.label} className="snav__link" />
                ) : (
                  <NavLink
                    to={link.to}
                    className={({ isActive }) =>
                      `snav__link${isActive ? " is-active" : ""}${link.id === "watch" && isLive ? " is-live" : ""}`
                    }
                    onClick={link.id === "watch" ? watchClickHandler(pathname) : undefined}
                  >
                    {link.shortLabel || link.label}
                    {link.id === "watch" && isLive ? <LiveIndicator /> : null}
                  </NavLink>
                )}
              </li>
            ))}
            {more.length > 0 ? <MoreMenu links={more} pathname={pathname} /> : null}
          </ul>
        </nav>

        <div className="snav__actions">
          {isAuthenticated ? (
            <>
              <NotificationBell buttonClassName="snav__icon-btn" />
              <Link
                to={SITE_CONSOLE_PATH}
                className={`snav__cta snav__cta--bar${isSiteLinkActive({ to: SITE_CONSOLE_PATH }, pathname) ? " is-active" : ""}`}
              >
                Console
                <ConsoleIcon className="snav__icon" />
              </Link>
              <AccountMenu user={user} groups={accountGroups} onSignOut={onLogout} pathname={pathname} />
            </>
          ) : (
            <>
              <Link to="/login" className="snav__ghost snav__ghost--bar">
                Sign in
              </Link>
              <Link to="/courses" className="snav__cta snav__cta--bar snav__cta--guest">
                Browse courses
              </Link>
            </>
          )}
          <button
            ref={menuButtonRef}
            type="button"
            className="snav__icon-btn snav__menu-btn"
            onClick={() => setMobileMenuOpen((value) => !value)}
            aria-label={
              mobileMenuOpen ? "Close navigation menu" : `Open navigation menu${isLive ? " (YouTube live now)" : ""}`
            }
            aria-expanded={mobileMenuOpen}
            aria-controls={mobileMenuOpen ? sheetId : undefined}
            aria-haspopup="dialog"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="snav__icon" fill="currentColor">
              <path d="M2 3h12v1H2zM2 7.5h12v1H2zM2 12h12v1H2z" />
            </svg>
            {isLive && !mobileMenuOpen ? <span className="snav__menu-live" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>

      {mobileMenuOpen ? (
        <MobileSheet
          id={sheetId}
          isAuthenticated={isAuthenticated}
          user={user}
          siteGroups={siteGroups}
          accountGroups={accountGroups}
          onSignOut={onLogout}
          onClose={closeMobileMenu}
          returnFocusRef={menuButtonRef}
          pathname={pathname}
          watchState={watchState}
        />
      ) : null}
    </header>
  );
}
