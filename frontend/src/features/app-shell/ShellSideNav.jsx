import { ChevronDown, Earth, Launch, Locked, SidePanelClose, SidePanelOpen } from "@carbon/icons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CHANGELOG_PATH, CURRENT_VERSION } from "../../config/releaseNotes";
import { LiveDot } from "../../site-kit/motion";
import { WORKSPACE_ADMIN } from "./navConfig";
import { getNavIcon } from "./navIcons";
import { DisabledReason } from "./ui";
import WorkspaceSwitch from "./WorkspaceSwitch";

export const SIDE_NAV_ID = "cds-app-side-nav";

/** "Back to website": the public landing page, at the top of the side nav and the phone sheet. */
export function WebsiteHomeLink({ rail = false, onNavigate, className = "" }) {
  return (
    <Link
      className={`cds-app-nav-row cds-app-website-link${className ? ` ${className}` : ""}`}
      to="/"
      title={rail ? "Back to website" : undefined}
      data-website-home="true"
      onClick={onNavigate}
    >
      <Earth size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
      <span className="cds-app-nav-row__label">Back to website</span>
    </Link>
  );
}

/** The release pill: opens the public "What's new" page. */
export function VersionPill({ onNavigate, className = "" }) {
  return (
    <Link
      className={`cds-app-version${className ? ` ${className}` : ""}`}
      to={CHANGELOG_PATH}
      aria-label={`Version ${CURRENT_VERSION}: what's new`}
      onClick={onNavigate}
    >
      {CURRENT_VERSION}
    </Link>
  );
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Trailing hint on a row: live dot, "something due" dot, or the new-tab icon. */
function RowTrail({ item, signals }) {
  if (item.external) {
    return (
      <>
        {item.chip ? <span className="cds-app-nav-row__chip">{item.chip}</span> : null}
        <Launch size={16} className="cds-app-nav-row__trail" aria-hidden="true" />
        <span className="cds--visually-hidden"> (opens in a new tab)</span>
      </>
    );
  }
  if (item.signal === "live" && signals?.live) {
    return (
      <span className="cds-app-nav-row__trail cds-app-nav-row__trail--signal">
        <LiveDot state="live" />
        <span className="cds--visually-hidden"> (a class is live now)</span>
      </span>
    );
  }
  if (item.signal === "coursework" && signals?.coursework) {
    return (
      <span className="cds-app-nav-row__trail cds-app-nav-row__trail--signal">
        <span className="cds-app-nav-row__dot" aria-hidden="true" />
        <span className="cds--visually-hidden"> (something is due)</span>
      </span>
    );
  }
  return null;
}

/** One 40 px nav row: link, external link, or a focusable disabled row with its reason. */
export function NavRow({ item, active, rail = false, signals, onNavigate }) {
  const Icon = getNavIcon(item.icon);
  const title = rail ? item.label : undefined;
  if (item.state === "disabled") {
    return (
      <DisabledReason as="span" reason={item.reason} icon={null} className="cds-app-nav-row cds-app-nav-row--disabled" title={item.reason}>
        <Icon size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
        <span className="cds-app-nav-row__label">{item.label}</span>
        <Locked size={16} className="cds-app-nav-row__trail" aria-hidden="true" />
      </DisabledReason>
    );
  }
  const body = (
    <>
      <Icon size={20} className="cds-app-nav-row__icon" aria-hidden="true" />
      <span className="cds-app-nav-row__label">{item.label}</span>
      <RowTrail item={item} signals={signals} />
    </>
  );
  if (item.external) {
    return (
      <a className="cds-app-nav-row" href={item.href} target="_blank" rel="noopener noreferrer" title={title} data-external="true" onClick={onNavigate}>
        {body}
      </a>
    );
  }
  return (
    <Link className="cds-app-nav-row" to={item.to} aria-current={active ? "page" : undefined} title={title} onClick={onNavigate}>
      {body}
    </Link>
  );
}

function SectionList({ items, activeId, signals }) {
  return (
    <ul className="cds-app-sidenav__list">
      {items.map((item) => (
        <li key={item.id}>
          <NavRow item={item} active={item.id === activeId} signals={signals} />
        </li>
      ))}
    </ul>
  );
}

/** Admin group: a disclosure (M12, chevron only, no height animation). */
function NavGroup({ section, open, onToggle, activeId, signals }) {
  const listId = useId();
  const containsActive = section.items.some((item) => item.id === activeId);
  return (
    <div className={`cds-app-sidenav__group${containsActive ? " is-current" : ""}`}>
      <button
        type="button"
        className="cds-app-sidenav__group-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => onToggle(section.id)}
      >
        <span>{section.label}</span>
        <ChevronDown size={16} className="cds-app-sidenav__chevron" aria-hidden="true" />
      </button>
      <div id={listId} hidden={!open} className="cds-app-sidenav__group-body">
        <SectionList items={section.items} activeId={activeId} signals={signals} />
      </div>
    </div>
  );
}

/** Collapsed rail: one icon per item (Learn/Teach) or per admin group. */
function RailList({ nav, signals }) {
  const activeId = nav.activeItem?.id;
  if (nav.workspace === WORKSPACE_ADMIN) {
    return (
      <ul className="cds-app-sidenav__list">
        {nav.sections.map((section) => {
          const target = section.items.find((item) => !item.external) || section.items[0];
          const item = { ...target, id: `group-${section.id}`, label: section.label, icon: section.icon || target.icon };
          const active = section.items.some((entry) => entry.id === activeId);
          return (
            <li key={section.id}>
              <NavRow item={item} active={active} rail signals={signals} />
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ul className="cds-app-sidenav__list">
      {nav.items.map((item) => (
        <li key={item.id}>
          <NavRow item={item} active={item.id === activeId} rail signals={signals} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Desktop side navigation (≥1056 px, plan §3.1): workspace switch on top,
 * 40 px rows with 20 px icons, sentence-case group labels, one champagne bar
 * that slides to the current row (M13), and a Collapse footer (M16: the
 * width never animates). Admin groups are disclosures; only the current one
 * starts open, so the nav fits 1440×768 without scrolling.
 */
export default function ShellSideNav({ nav, collapsed = false, forcedRail = false, onToggleCollapsed, onWorkspaceChange, signals }) {
  const rail = collapsed || forcedRail;
  const scrollRef = useRef(null);
  const indicatorRef = useRef(null);
  const activeId = nav.activeItem?.id || "";
  const activeSectionId = nav.activeSection?.id || "";
  const [openGroups, setOpenGroups] = useState(() => new Set(activeSectionId ? [activeSectionId] : ["today"]));

  // Following a link into another group opens that group (others keep their state).
  useEffect(() => {
    if (!activeSectionId) return;
    setOpenGroups((previous) => (previous.has(activeSectionId) ? previous : new Set([...previous, activeSectionId])));
  }, [activeSectionId]);

  const toggleGroup = (id) =>
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // M13: one indicator moved with transform to the current row.
  useIsoLayoutEffect(() => {
    const container = scrollRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const current = container.querySelector('[aria-current="page"]');
    if (!current || current.offsetParent === null) {
      indicator.style.opacity = "0";
      return;
    }
    const containerBox = container.getBoundingClientRect();
    const box = current.getBoundingClientRect();
    const top = box.top - containerBox.top + container.scrollTop + (box.height - 24) / 2;
    indicator.style.transform = `translateY(${Math.round(top)}px)`;
    indicator.style.opacity = "1";
    if (!indicator.dataset.ready) {
      // First placement jumps; later moves slide.
      requestAnimationFrame(() => {
        if (indicatorRef.current) indicatorRef.current.dataset.ready = "true";
      });
    }
  }, [activeId, rail, openGroups, nav.workspace, nav.items.length]);

  const isAdmin = nav.workspace === WORKSPACE_ADMIN;

  return (
    <nav
      id={SIDE_NAV_ID}
      aria-label="Main navigation"
      className={`cds-app-sidenav${rail ? " cds-app-sidenav--rail" : ""}`}
      data-workspace={nav.workspace}
    >
      <div className="cds-app-sidenav__home">
        <WebsiteHomeLink rail={rail} />
      </div>
      {!rail && nav.workspaces.length > 1 ? (
        <WorkspaceSwitch className="cds-app-sidenav__workspace" options={nav.workspaces} value={nav.workspace} onChange={onWorkspaceChange} />
      ) : null}
      <div ref={scrollRef} className="cds-app-sidenav__scroll">
        <span ref={indicatorRef} className="cds-app-sidenav__indicator" aria-hidden="true" />
        {rail ? (
          <RailList nav={nav} signals={signals} />
        ) : (
          nav.sections.map((section) =>
            isAdmin ? (
              <NavGroup
                key={section.id}
                section={section}
                open={openGroups.has(section.id)}
                onToggle={toggleGroup}
                activeId={activeId}
                signals={signals}
              />
            ) : (
              <div key={section.id} className="cds-app-sidenav__section">
                {section.label ? <h2 className="cds-app-sidenav__heading">{section.label}</h2> : null}
                <SectionList items={section.items} activeId={activeId} signals={signals} />
              </div>
            )
          )
        )}
      </div>
      {!rail ? (
        <div className="cds-app-sidenav__release">
          <VersionPill />
        </div>
      ) : null}
      {onToggleCollapsed && !forcedRail ? (
        <div className="cds-app-sidenav__footer">
          <button
            type="button"
            className="cds-app-sidenav__toggle"
            aria-controls={SIDE_NAV_ID}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand menu" : undefined}
            onClick={onToggleCollapsed}
          >
            {collapsed ? <SidePanelOpen size={20} aria-hidden="true" /> : <SidePanelClose size={20} aria-hidden="true" />}
            <span className="cds-app-sidenav__toggle-label">{collapsed ? "Expand menu" : "Collapse menu"}</span>
          </button>
        </div>
      ) : null}
    </nav>
  );
}
