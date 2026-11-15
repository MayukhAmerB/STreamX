import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import capabilities from "../../__contracts__/ui-overhaul/capabilities.json";
import { AuthContext } from "../../context/AuthContext";
import { act, renderTree } from "../../test-utils/renderTree";
import AppShellLayout from "./AppShellLayout";
import BottomNav from "./BottomNav";
import MoreSheet from "./MoreSheet";
import { buildShellNav } from "./navConfig";
import WorkspaceSwitch from "./WorkspaceSwitch";

const STUDENT = { id: 1, full_name: "Asha Rao", email: "asha@example.com", role: "student", capabilities: capabilities.student };
const INSTRUCTOR_OFF = { id: 2, full_name: "Imran Syed", email: "imran@example.com", role: "instructor", capabilities: capabilities.instructor_off };
const INSTRUCTOR_ON = { ...INSTRUCTOR_OFF, capabilities: capabilities.instructor_on };
const STAFF = { id: 3, full_name: "Ayesha Khan", email: "ayesha@example.com", role: "student", is_admin: true, capabilities: capabilities.staff_off };

function authFor(user) {
  return {
    user,
    isAuthenticated: true,
    isInstructor: user.role === "instructor",
    isAdmin: Boolean(user.is_admin),
    logout: async () => {},
  };
}

function renderShell({ path = "/my-courses", user = STUDENT } = {}) {
  return renderToStaticMarkup(
    <AuthContext.Provider value={authFor(user)}>
      <StaticRouter location={path}>
        <Routes>
          <Route element={<AppShellLayout />}>
            <Route path="*" element={<p>Page body</p>} />
          </Route>
        </Routes>
      </StaticRouter>
    </AuthContext.Provider>
  );
}

/** href of the one link marked aria-current="page". */
function currentHref(html) {
  return html.match(/<a [^>]*aria-current="page"[^>]*href="([^"]+)"/)?.[1] || "";
}

function sideNav(html) {
  const start = html.indexOf('id="cds-app-side-nav"');
  return html.slice(start, html.indexOf("</nav>", html.indexOf("cds-app-sidenav__scroll", start)) + 6);
}

describe("AppShellLayout", () => {
  it("renders the header, side nav and page inside the scoped shell root", () => {
    const html = renderShell();
    expect(html).toMatch(/^<div class="cds-app" data-shell-layout="desktop" data-workspace="learn">/);
    expect(html).toContain('class="cds-app-header"');
    expect(html).toContain("Skip to main content");
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('<div class="cds-page"><p>Page body</p></div>');
  });

  it("has a 48 px header: brand (to the website home), breadcrumb, Jump to…, bell and avatar menu (no 'Console' eyebrow)", () => {
    const html = renderShell({ path: "/reports" });
    expect(html).toContain('<a class="cds-app-header__brand" aria-label="Al syed Initiative: back to the website home page" href="/">');
    expect(html).toContain('<span class="cds-app-brand__name">Al syed Initiative</span>');
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('<span aria-current="page">Coursework</span>');
    expect(html).toContain("Jump to…");
    expect(html).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(html).toContain('aria-label="Notifications"');
    expect(html).toContain('aria-label="Account and settings"');
    const header = html.slice(html.indexOf('class="cds-app-header"'), html.indexOf("</header>"));
    expect(header).not.toContain("Back to website");
    expect(html).not.toMatch(/>\s*Console\s*</);
    expect(html).not.toContain("uc-header__section");
    expect(html).not.toContain("cds-app-sidenav__title");
  });

  it("gives students the Learn nav with no workspace switch and one current row", () => {
    const html = renderShell({ path: "/console" });
    const nav = sideNav(html);
    expect(nav).not.toContain('aria-label="Workspace"');
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(currentHref(nav)).toBe("/console");
    for (const label of ["Home", "Courses", "Live classes", "Coursework", "OSINT tools", "Labs", "Guides"]) {
      expect(nav).toContain(`<span class="cds-app-nav-row__label">${label}</span>`);
    }
    for (const gone of ["Continue learning", "Overview", "Account", "Control center", "Teaching"]) {
      expect(nav).not.toContain(`>${gone}<`);
    }
    expect(nav).toContain('<h2 class="cds-app-sidenav__heading">Practice</h2>');
  });

  it("opens Labs in a new tab and never marks it current", () => {
    const labs = renderShell({ path: "/osint-tools" }).match(/<a class="cds-app-nav-row" href="https:\/\/labs\.alsyedinitiative\.com"[^>]*>.*?<\/a>/)?.[0] || "";
    expect(labs).toContain('target="_blank"');
    expect(labs).toContain('rel="noopener noreferrer"');
    expect(labs).toContain("(opens in a new tab)");
    expect(labs).not.toContain("aria-current");
  });

  it("shows instructors a disabled, focusable Teach segment with the reason while teaching is off", () => {
    const html = renderShell({ path: "/console", user: INSTRUCTOR_OFF });
    expect(html).toContain('aria-label="Workspace"');
    const teach = html.match(/<button[^>]*aria-disabled="true"[^>]*>.*?<\/button>/)?.[0] || "";
    expect(teach).toContain("Teach");
    expect(teach).not.toContain("disabled=\"\"");
    expect(teach).toContain("Teaching tools are switched off for now. An admin can turn them on.");
    // Learn stays the nav; no dead Teach links.
    expect(sideNav(html)).not.toContain("/console/teach");
  });

  it("gives instructors the Teach nav when teaching is on", () => {
    const html = renderShell({ path: "/console/teach/grading", user: INSTRUCTOR_ON });
    const nav = sideNav(html);
    expect(html).toContain('data-workspace="teach"');
    for (const label of ["Today", "Courses", "Classes", "Recordings", "Grading", "Exams"]) {
      expect(nav).toContain(`<span class="cds-app-nav-row__label">${label}</span>`);
    }
    expect(currentHref(nav)).toBe("/console/teach/grading");
    expect(html).toContain('<a href="/console/teach">Teach</a>');
  });

  it("gives staff Learn | Admin and the 8 admin groups, only the current one open", () => {
    const html = renderShell({ path: "/console/admin/grading", user: STAFF });
    const nav = sideNav(html);
    expect(html).toContain('data-workspace="admin"');
    const groups = [...nav.matchAll(/<button type="button" class="cds-app-sidenav__group-toggle" aria-expanded="(true|false)"[^>]*><span>([^<]+)<\/span>/g)].map(
      (match) => [match[2].replace("&amp;", "&"), match[1]]
    );
    expect(groups).toEqual([
      ["Today", "false"],
      ["Live classes", "false"],
      ["Content", "false"],
      ["Students &amp; sales".replace("&amp;", "&"), "false"],
      ["Assessments", "true"],
      ["Community", "false"],
      ["Settings", "false"],
      ["System", "false"],
    ]);
    expect(currentHref(nav)).toBe("/console/admin/grading");
    expect(html).toContain('<a href="/console/admin">Admin</a>');
    // The back office is one click away in the avatar menu (rendered on open) and in System.
    expect(nav).toContain(">Back office<");
  });

  it("highlights the admin row for an old staff URL (no redirect yet)", () => {
    const html = renderShell({ path: "/report-grading/queue", user: STAFF });
    expect(currentHref(sideNav(html))).toBe("/console/admin/grading");
  });

  it("switches to focus mode for the player: rail, back arrow, no collapse toggle", () => {
    const html = renderShell({ path: "/learn/12" });
    expect(html).toContain('data-sidenav="rail"');
    expect(html).toContain('data-focus="true"');
    expect(html).toContain('aria-label="Back to Courses"');
    expect(html).not.toContain("cds-app-sidenav__toggle");
  });

  it("offers a collapse toggle for the side nav", () => {
    const html = renderShell();
    expect(html).toMatch(/<button type="button" class="cds-app-sidenav__toggle" aria-controls="cds-app-side-nav" aria-expanded="true"/);
    expect(html).toContain("Collapse menu");
  });

  it("wraps not-yet-migrated pages in the legacy frame", () => {
    const html = renderShell({ path: "/some-legacy-page", user: INSTRUCTOR_ON });
    expect(html).toContain('<div class="cds-legacy-frame"><p>Page body</p></div>');
  });
});

describe("BottomNav", () => {
  function renderBottom(user, path) {
    const nav = buildShellNav(authFor(user), { pathname: path, caps: user.capabilities });
    return renderToStaticMarkup(
      <StaticRouter location={path}>
        <BottomNav items={nav.bottomItems} activeId={nav.activeItem?.id} moreActive={false} moreOpen={false} onMoreClick={() => {}} />
      </StaticRouter>
    );
  }

  it("renders Home · Courses · Live · Work + More for students, with the current tab", () => {
    const html = renderBottom(STUDENT, "/learn/3");
    expect(html.match(/cds-app-bottom-nav__item/g)).toHaveLength(5);
    const labels = [...html.matchAll(/<span class="cds-app-bottom-nav__label">([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Home", "Courses", "Live", "Work", "More"]);
    expect(html).toMatch(/class="cds-app-bottom-nav__item is-active" aria-current="page" href="\/my-courses"|href="\/my-courses" class="cds-app-bottom-nav__item is-active" aria-current="page"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('class="cds-app-bottom-nav__indicator"');
  });

  it("names short tabs by their full destination (label in name)", async () => {
    const { tabAccessibleName } = await import("./BottomNav");
    expect(tabAccessibleName({ label: "Coursework", shortLabel: "Work" })).toBe("Coursework");
    expect(tabAccessibleName({ label: "Live classes", shortLabel: "Live", signal: "live" }, { live: true })).toBe("Live classes (live now)");
    expect(tabAccessibleName({ label: "Classes & studio", shortLabel: "Live" })).toBeUndefined();
    expect(tabAccessibleName({ label: "Home", shortLabel: "Home" })).toBeUndefined();
  });

  it("gives staff a Search tab that is a button (opens the palette)", () => {
    const html = renderBottom(STAFF, "/console/admin");
    const labels = [...html.matchAll(/<span class="cds-app-bottom-nav__label">([^<]+)<\/span>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Home", "Live", "Grading", "Search", "More"]);
    expect(html).toMatch(/<button type="button" class="cds-app-bottom-nav__item">.*Search/);
  });
});

describe("MoreSheet", () => {
  function renderSheet(user, path) {
    const nav = buildShellNav(authFor(user), { pathname: path, caps: user.capabilities });
    return renderToStaticMarkup(
      <StaticRouter location={path}>
        <div className="cds-app">
          <MoreSheet nav={nav} user={user} pathname={path} backOfficeUrl={user.is_admin ? "/admin/" : ""} onSignOut={() => {}} onClose={() => {}} returnFocusRef={{ current: null }} />
        </div>
      </StaticRouter>
    );
  }

  it("is a modal dialog that starts with the viewer, then destinations and account rows", () => {
    const html = renderSheet(STUDENT, "/console");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html.indexOf("Asha Rao")).toBeLessThan(html.indexOf("OSINT tools"));
    for (const label of ["Guides", "OSINT tools", "Labs", "Profile", "ID card", "Reduce motion", "Back to website", "Sign out", "v4.0-Thrallback"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("Back office");
    expect(html).not.toContain('aria-label="Workspace"');
  });

  it("puts the workspace switch first for instructors, Teach disabled while off", () => {
    const html = renderSheet(INSTRUCTOR_OFF, "/console");
    expect(html.indexOf('aria-label="Workspace"')).toBeLessThan(html.indexOf("OSINT tools"));
    expect(html).toMatch(/aria-disabled="true"[^>]*>.*Teach/);
  });

  it("lists every admin group as a disclosure row for staff (current one open), back office once", () => {
    const html = renderSheet(STAFF, "/console/admin/requests");
    for (const label of ["Today", "Live classes", "Content", "Students &amp; sales", "Assessments", "Community", "Settings", "System"]) {
      expect(html).toContain(`<span>${label}</span>`);
    }
    expect(html).toMatch(/class="cds-app-sheet__group-toggle" aria-expanded="true"[^>]*><span>Students &amp; sales<\/span>/);
    expect(html).toMatch(/aria-expanded="false"[^>]*><span>Assessments<\/span>/);
    // The back office is a System row in the Admin workspace, not repeated in Account.
    expect(html.match(/>Back office</g)).toHaveLength(1);
  });

  it("is capped at 85 vh with 56 px rows (styles)", () => {
    const scss = readFileSync(new URL("./styles/_shell.scss", import.meta.url), "utf8");
    const panel = scss.slice(scss.indexOf(".cds-app-sheet__panel {"));
    expect(panel.slice(0, 900)).toMatch(/max-block-size:\s*85(?:vh|dvh)/);
    expect(scss).toMatch(/\.cds-app-sheet \.cds-app-nav-row[^{]*\{[^}]*min-block-size:\s*(?:56px|3\.5rem)/);
  });
});

describe("WorkspaceSwitch", () => {
  it("explains a disabled segment when it is pressed or focused", async () => {
    const options = buildShellNav(authFor(INSTRUCTOR_OFF), { pathname: "/console", caps: capabilities.instructor_off }).workspaces;
    const tree = await renderTree(<WorkspaceSwitch options={options} value="learn" onChange={() => {}} />);
    const reason = () => tree.find((node) => node.type === "p" && node.props.className === "cds-app-workspace__reason");
    expect(reason().children).toHaveLength(0);
    const root = tree.find((node) => node.type === "div" && String(node.props.className).includes("cds-app-workspace"));
    await act(() => root.props.onClickCapture({}));
    expect(tree.text()).toContain("Teach: Teaching tools are switched off for now. An admin can turn them on.");
    expect(reason().props["aria-live"]).toBe("polite");
    await tree.unmount();
  });

  it("renders nothing for a single workspace", () => {
    const html = renderToStaticMarkup(<WorkspaceSwitch options={[{ key: "learn", label: "Learn", state: "enabled" }]} value="learn" />);
    expect(html).toBe("");
  });
});

describe("Website home link and version pill", () => {
  it("puts 'Back to website' (to /) at the top of the side nav and the release pill (to /changelog) in its footer", () => {
    const html = renderShell({ path: "/reports" });
    const start = html.indexOf('id="cds-app-side-nav"');
    const nav = html.slice(start, html.indexOf("</nav>", html.lastIndexOf("cds-app-sidenav__release")) + 6);
    const home = nav.indexOf('data-website-home="true"');
    expect(home).toBeGreaterThan(-1);
    expect(home).toBeLessThan(nav.indexOf("cds-app-sidenav__scroll"));
    expect(nav).toMatch(/<a class="cds-app-nav-row cds-app-website-link"[^>]*href="\/">.*?Back to website/);
    expect(nav).toContain('<a class="cds-app-version" aria-label="Version v4.0-Thrallback: what&#x27;s new" href="/changelog">v4.0-Thrallback</a>');
  });

  it("opens the phone sheet with 'Back to website' before every destination", () => {
    const user = STUDENT;
    const nav = buildShellNav(authFor(user), { pathname: "/console", caps: user.capabilities });
    const html = renderToStaticMarkup(
      <StaticRouter location="/console">
        <MoreSheet nav={nav} user={user} pathname="/console" onSignOut={() => {}} onClose={() => {}} returnFocusRef={{ current: null }} />
      </StaticRouter>
    );
    expect(html.indexOf("Back to website")).toBeGreaterThan(-1);
    expect(html.indexOf("Back to website")).toBeLessThan(html.indexOf("OSINT tools"));
    expect(html).toContain('href="/changelog"');
  });
});
