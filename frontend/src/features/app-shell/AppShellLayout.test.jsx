import { renderToStaticMarkup } from "react-dom/server";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { AuthContext } from "../../context/AuthContext";
import AppShellLayout from "./AppShellLayout";
import BottomNav from "./BottomNav";
import { getBottomNavItems, getNavItems } from "./navConfig";

function renderShell({ path = "/my-courses", auth = {} } = {}) {
  const value = {
    user: { id: 1, full_name: "Asha Rao", email: "asha@example.com", role: "student" },
    isAuthenticated: true,
    isInstructor: false,
    isAdmin: false,
    logout: async () => {},
    ...auth,
  };
  return renderToStaticMarkup(
    <AuthContext.Provider value={value}>
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

describe("AppShellLayout", () => {
  it("renders the Carbon header, side nav and page inside the scoped shell root", () => {
    const html = renderShell();
    // Dark only: one Console theme, no Carbon White/G100 switch.
    expect(html).toMatch(/^<div class="cds-app" data-shell-layout="desktop">/);
    expect(html).toContain('class="cds--header"');
    expect(html).toContain("Skip to main content");
    expect(html).toContain('aria-label="Account and settings"');
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain("Page body");
    // Carbon-native page: no legacy dark frame.
    expect(html).toContain('<div class="cds-page"><p>Page body</p></div>');
  });

  it("brands the shell as the Console with the website brand block and a way back", () => {
    const html = renderShell();
    expect(html).toContain('aria-label="Al syed Initiative Console"');
    // Brand block (logo + name + platform label) links to the Console home.
    expect(html).toMatch(/<a[^>]*class="cds--header__name uc-header__brand"[^>]*href="\/console"/);
    expect(html).toContain('src="/logo.jpeg"');
    expect(html).toContain('<span class="uc-brand__name">Al syed Initiative</span>');
    expect(html).toContain('<span class="uc-brand__platform">Cybersecurity Platform</span>');
    expect(html).toContain('<span class="uc-header__section">Console</span>');
    expect(html).toContain('<li class="cds-app-sidenav__title">Console</li>');
    expect(html).toContain('<span class="uc-brand__corner">Console</span>');
    expect(html).not.toMatch(/User(&#x27;|')s Corner/);
    expect(html).toMatch(/<a class="uc-header__back" href="\/">.*Back to website<\/span><\/a>/);
    // The Light / Dark / Auto switcher is gone.
    expect(html).not.toContain("Appearance");
    expect(html).not.toContain("data-carbon-theme");
  });

  it("makes Overview the first destination and highlights it on the hub", () => {
    const html = renderShell({ path: "/console" });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/console"/);
    const firstNavLink = html.slice(html.indexOf("cds-app-sidenav__title")).match(/href="([^"]+)"/);
    expect(firstNavLink[1]).toBe("/console");
  });

  it("groups the side nav under micro-label headings", () => {
    const html = renderShell();
    const headings = [...html.matchAll(/<span class="cds-app-sidenav__heading-text">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(headings).toEqual(["Learn", "Account"]);
  });

  it("links Labs as an external site in a new tab, never as the current page", () => {
    for (const path of ["/console", "/osint-tools", "/labs"]) {
      const html = renderShell({ path });
      const labs = html.match(/<a[^>]*href="https:\/\/labs\.alsyedinitiative\.com"[^>]*>.*?<\/a>/)?.[0] || "";
      expect(labs).toContain('target="_blank"');
      expect(labs).toContain('rel="noopener noreferrer"');
      expect(labs).toContain("Labs");
      expect(labs).toContain("(opens in a new tab)");
      expect(labs).not.toContain("aria-current");
      expect(labs).not.toContain("side-nav__link--current");
    }
    // Sits right after OSINT tools in the Learn group.
    const html = renderShell();
    expect(html.indexOf("labs.alsyedinitiative.com")).toBeGreaterThan(html.indexOf('href="/osint-tools"'));
    expect(html.indexOf("labs.alsyedinitiative.com")).toBeLessThan(html.indexOf('href="/profile"'));
  });

  it("offers a collapse toggle for the desktop side nav", () => {
    const html = renderShell();
    expect(html).toMatch(/<button type="button" class="cds-app-sidenav__toggle" aria-controls="cds-app-side-nav" aria-expanded="true"/);
    expect(html).toContain("Collapse menu");
  });

  it("marks only the active destination with aria-current", () => {
    const html = renderShell({ path: "/guides" });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/guides"/);
  });

  it("wraps not-yet-migrated pages (the staff tools) in the legacy frame", () => {
    const html = renderShell({
      path: "/broadcasting",
      auth: { isInstructor: true, user: { role: "instructor", full_name: "T" } },
    });
    expect(html).toContain('<div class="cds-legacy-frame"><p>Page body</p></div>');
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/broadcasting"/);
  });

  it("shows teaching tools only to staff", () => {
    expect(renderShell()).not.toContain("Control center");
    const staff = renderShell({ auth: { isInstructor: true, user: { role: "instructor", full_name: "T" } } });
    expect(staff).toContain("Teaching");
    expect(staff).toContain("Control center");
    expect(staff).toContain("Instructor dashboard");
    expect(staff).not.toContain("Lecture questions");
  });
});

describe("BottomNav", () => {
  it("renders four icon + label tabs (Overview first) plus More with the active state", () => {
    const items = getBottomNavItems(getNavItems({}));
    const html = renderToStaticMarkup(
      <StaticRouter location="/learn/3">
        <BottomNav items={items} pathname="/learn/3" moreActive={false} moreOpen={false} onMoreClick={() => {}} />
      </StaticRouter>
    );
    expect(html.match(/cds-app-bottom-nav__item/g)).toHaveLength(5);
    expect(html).toContain(">Overview<");
    expect(html).toContain(">Courses<");
    expect(html).toContain(">Learn<");
    expect(html).toContain(">Live<");
    expect(html).not.toContain(">Profile<");
    expect(html).toContain(">More<");
    expect(html.indexOf(">Overview<")).toBeLessThan(html.indexOf(">Courses<"));
    expect(html).toMatch(/class="cds-app-bottom-nav__item is-active" aria-current="page"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
