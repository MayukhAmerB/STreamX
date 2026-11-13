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
  isSiteLinkActive,
  SITE_CONSOLE_PATH,
} from "./siteNavModel";

const SCROLLED_AFTER_PX = 8;
const DESKTOP_QUERY = "(min-width: 1024px)";

function ChevronIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function ArrowIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function ExternalIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 3.5H3.5v9h9v-3M9 3h4v4M13 3 7.5 8.5" />
    </svg>
  );
}

function ConsoleIcon({ className = "" }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M5 6.5 7 8l-2 1.5M8.5 10H11" />
    </svg>
  );
}

/** Small pulsing red dot + "Live" shown next to "Watch" while the channel is live. */
function LiveIndicator() {
  return (
    <span className="snav__live">
      <span className="snav__live-dot" aria-hidden="true" />
      Live
    </span>
  );
}

/**
 * On the landing page "Watch" scrolls to the section (smoothly, below the
 * sticky header); everywhere else, or if the section is hidden, it opens /watch.
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

function trapTab(event, container) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
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

/** Phone / tablet: a full-screen sheet with grouped links and the main action at the bottom. */
function MobileSheet({ id, isAuthenticated, user, siteGroups, accountGroups, onSignOut, onClose, returnFocusRef, pathname, isLive }) {
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
        <BrandLogo className="snav__brand" />
        <h2 id={titleId} className="sr-only">
          Site menu
        </h2>
        <button type="button" className="snav__icon-btn" aria-label="Close navigation menu" onClick={close}>
          <svg aria-hidden="true" viewBox="0 0 16 16" className="snav__icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
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
                    {link.id === "watch" ? (
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
                        <span className="snav-sheet__label">
                          {link.label}
                          {isLive ? <LiveIndicator /> : null}
                        </span>
                        <ArrowIcon className="snav-sheet__arrow" />
                      </NavLink>
                    ) : (
                      <NavLink to={link.to} className="snav-sheet__link" onClick={onClose}>
                        <span>{link.label}</span>
                        <ArrowIcon className="snav-sheet__arrow" />
                      </NavLink>
                    )}
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
                      {link.external ? (
                        <a href={link.href} target="_blank" rel="noopener noreferrer" className="snav-sheet__link" onClick={onClose}>
                          <span>{link.label}</span>
                          <ExternalIcon className="snav-sheet__arrow" />
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      ) : (
                        <NavLink to={link.to} className="snav-sheet__link" onClick={onClose}>
                          <span>{link.label}</span>
                          <ArrowIcon className="snav-sheet__arrow" />
                        </NavLink>
                      )}
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
            <ConsoleIcon className="snav__icon" />
            Open Console
          </Link>
        ) : (
          <>
            <Link to="/courses" className="snav__cta snav__cta--block" onClick={onClose}>
              Browse courses
            </Link>
            <Link to="/login" className="snav__ghost snav__ghost--block" onClick={onClose}>
              Sign in
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Website navbar: brand on the left, a centred pill with the key links and
 * "More", and on the right the bell, avatar menu and the champagne Console
 * button (guests: Sign in + Browse courses). Phones and tablets get a
 * full-screen sheet. The bar keeps one height in every state (no layout
 * shift); scrolling only adds the blur and the hairline.
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
  const navOptions = { youtube: siteBrand.youtube && youtube.enabled !== false };
  const isLive = navOptions.youtube && Boolean(youtube.model?.live);
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
      className={`snav sticky top-0${mobileMenuOpen ? " z-50" : " z-20"}`}
      data-scrolled={scrolled ? "true" : "false"}
    >
      <div className="snav__backdrop" aria-hidden="true" />
      <div className="snav__bar">
        <BrandLogo className="snav__brand" />

        <nav className="snav__primary" aria-label="Main">
          <ul className="snav__pill">
            {primary.map((link) => (
              <li key={link.id}>
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
                <ConsoleIcon className="snav__icon" />
                Console
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
            <svg aria-hidden="true" viewBox="0 0 16 16" className="snav__icon" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2.5 5h11M2.5 11h11" />
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
          isLive={isLive}
        />
      ) : null}
    </header>
  );
}
