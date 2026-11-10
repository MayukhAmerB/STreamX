import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { AuthContext } from "../context/AuthContext";
import Navbar from "./Navbar";
import {
  getAccountMenuGroups,
  getInitials,
  getShortName,
  getSiteNavGroups,
  getSiteNavLinks,
  isSiteLinkActive,
} from "./siteNavModel";

const ids = (links) => links.map((link) => link.id);
const asha = { id: 7, full_name: "Asha Rao", email: "asha.rao@example.com", role: "student", terms_acceptance_required: false };

function render({ path = "/", auth = {} } = {}) {
  const value = {
    user: null,
    isAuthenticated: false,
    isInstructor: false,
    isAdmin: false,
    logout: async () => {},
    ...auth,
  };
  return renderToStaticMarkup(
    <AuthContext.Provider value={value}>
      <StaticRouter location={path}>
        <Navbar />
      </StaticRouter>
    </AuthContext.Provider>
  );
}

describe("site nav model", () => {
  it("puts four key links in the pill and the rest under More for Al syed", () => {
    const { primary, more } = getSiteNavLinks("alsyed");
    expect(ids(primary)).toEqual(["courses", "about", "national-desk", "contact"]);
    expect(ids(more)).toEqual(["accounts", "join", "hall-of-fame", "faqs"]);
  });

  it("shows OwlCognito's four links without a More menu or Al Syed programmes", () => {
    const { primary, more } = getSiteNavLinks("owlcognito");
    expect(ids(primary)).toEqual(["courses", "about", "contact", "faqs"]);
    expect(more).toEqual([]);
    const groups = getSiteNavGroups("owlcognito");
    expect(groups.map((group) => group.id)).toEqual(["explore"]);
  });

  it("keeps every previous website link reachable", () => {
    const previous = ["/courses", "/about", "/as-accounts", "/national-desk", "/join-alsyed", "/hall-of-fame", "/contact", "/faqs"];
    const { primary, more } = getSiteNavLinks("alsyed");
    expect([...primary, ...more].map((link) => link.to).sort()).toEqual([...previous].sort());
    const sheet = getSiteNavGroups("alsyed").flatMap((group) => group.links.map((link) => link.to));
    expect([...sheet].sort()).toEqual([...previous].sort());
  });

  it("gates the account menu like the previous navbar", () => {
    const linksFor = (flags) => getAccountMenuGroups({ djangoAdminUrl: "https://api.example.com/admin/", ...flags }).flatMap((group) => ids(group.links));
    expect(linksFor({})).toEqual(["console", "my-courses", "guides", "profile", "id-card"]);
    expect(linksFor({ isInstructor: true })).toEqual([
      "console", "my-courses", "guides", "profile", "id-card", "instructor", "control-center", "meeting", "broadcasting",
    ]);
    expect(linksFor({ isAdmin: true })).toEqual([
      "console", "my-courses", "guides", "profile", "id-card", "control-center", "meeting", "broadcasting", "lecture-questions", "django-admin",
    ]);
    const django = getAccountMenuGroups({ isAdmin: true, djangoAdminUrl: "https://api.example.com/admin/" })
      .flatMap((group) => group.links)
      .find((link) => link.id === "django-admin");
    expect(django).toMatchObject({ external: true, href: "https://api.example.com/admin/" });
  });

  it("matches active links by path prefix and builds initials", () => {
    expect(isSiteLinkActive({ to: "/courses" }, "/courses/12")).toBe(true);
    expect(isSiteLinkActive({ to: "/courses" }, "/courses-x")).toBe(false);
    expect(isSiteLinkActive({ to: "/faqs" }, "/faqs/?q=1")).toBe(true);
    expect(getInitials({ full_name: "Asha Rao" })).toBe("AR");
    expect(getInitials({ full_name: "Asha" })).toBe("A");
    expect(getInitials({ email: "zed@example.com" })).toBe("Z");
    expect(getInitials(null)).toBe("?");
    expect(getShortName({ full_name: "Asha Rao" })).toBe("Asha");
    expect(getShortName({ email: "zed@example.com" })).toBe("zed");
  });
});

describe("Navbar", () => {
  it("shows guests the pill, a More menu, Sign in and Browse courses", () => {
    const html = render();
    expect(html).toContain('<nav class="snav__primary" aria-label="Main">');
    expect(html).toMatch(/<a class="snav__link" href="\/courses"[^>]*>Courses<\/a>/);
    expect(html).toMatch(/<a class="snav__link" href="\/about"[^>]*>About<\/a>/);
    // More is a keyboard-operable disclosure with its menu in the header (no portal).
    expect(html).toMatch(/<button type="button" class="snav__link snav__more-trigger" aria-expanded="false" aria-controls="[^"]+">More/);
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--more" hidden="">/);
    for (const href of ["/as-accounts", "/join-alsyed", "/hall-of-fame", "/faqs"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toMatch(/<a class="snav__ghost snav__ghost--bar" href="\/login">Sign in<\/a>/);
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar snav__cta--guest" href="\/courses">Browse courses<\/a>/);
    expect(html).not.toContain("Console");
    expect(html).not.toContain("Open notifications");
    expect(html).toContain('aria-label="Open navigation menu"');
    // The phone sheet is only rendered when opened.
    expect(html).not.toContain("snav-sheet");
  });

  it("marks the active page in the pill and lights up More for a page inside it", () => {
    expect(render({ path: "/courses/12" })).toMatch(/<a aria-current="page" class="snav__link is-active" href="\/courses"/);
    expect(render({ path: "/hall-of-fame" })).toContain('class="snav__link snav__more-trigger is-active"');
    expect(render({ path: "/" })).not.toContain("is-active");
  });

  it("gives signed-in users the champagne Console button, the bell and the avatar menu", () => {
    const html = render({ auth: { user: asha, isAuthenticated: true } });
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar" href="\/console">.*Console<\/a>/);
    expect(html).toContain('aria-label="Account menu for Asha Rao"');
    expect(html).toContain('<span class="snav__avatar" aria-hidden="true">AR</span>');
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--account" hidden="">/);
    for (const href of ["/console", "/my-courses", "/guides", "/profile", "/id-card"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain('<button type="button" class="snav__icon-btn" aria-label="Open notifications" aria-expanded="false">');
    expect(html).not.toContain(">Sign in<");
    expect(html).not.toContain("Staff tools");
    expect(html).not.toMatch(/User(&#x27;|')s Corner/);
  });

  it("lists staff tools for admins, with the Django admin opening in a new tab", () => {
    const html = render({ auth: { user: { ...asha, is_admin: true }, isAuthenticated: true, isAdmin: true } });
    expect(html).toContain("Staff tools");
    for (const href of ["/control-center", "/meeting", "/broadcasting", "/lecture-questions"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toMatch(/target="_blank" rel="noopener noreferrer" class="snav__menu-item"><span>Django Admin<\/span>/);
    expect(html).not.toContain('href="/instructor/dashboard"');
  });

  it("keeps one header height in every state (scroll only toggles the hairline/blur)", () => {
    const html = render();
    expect(html).toMatch(/^<header class="snav sticky top-0 z-20" data-scrolled="false">/);
    expect(html).toContain('<div class="snav__backdrop" aria-hidden="true"></div>');
  });
});
