import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import capabilityFixtures from "../__contracts__/ui-overhaul/capabilities.json";
import { AuthContext } from "../context/AuthContext";
import { act, fire, renderTree, textOf } from "../test-utils/renderTree";
import Navbar from "./Navbar";
import {
  getAccountMenuGroups,
  getInitials,
  getShortName,
  getSiteNavGroups,
  getSiteNavLinks,
  getWatchNavState,
  isSiteLinkActive,
  LABS_URL,
  SITE_ADMIN_PATH,
  TEACH_MENU_LINKS,
} from "./siteNavModel";

// The navbar reads the shared YouTube store; tests set what it returns.
const youtubeState = vi.hoisted(() => ({ current: { status: "idle", model: null, enabled: true } }));
vi.mock("../features/youtube/youTubeStore", () => ({ useYouTubeChannel: () => youtubeState.current }));
const liveModel = { live: { videoId: "LiVe1234567", title: "Live" }, featured: null, latest: [] };

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
  it("puts the learning links in the centre and every other page under More for Al syed", () => {
    const { primary, more } = getSiteNavLinks("alsyed");
    expect(ids(primary)).toEqual(["courses", "pentesting", "roadmap", "labs", "pricing"]);
    expect(ids(more)).toEqual(["about", "national-desk", "accounts", "join", "hall-of-fame", "contact", "faqs"]);
    // Pentesting is browsable while purchases are off: a calm "Soon" chip, never hidden.
    expect(primary.find((link) => link.id === "pentesting")).toMatchObject({ to: "/tracks/pentesting", chip: "Soon" });
  });

  it("shows OwlCognito's four links without a More menu or Al Syed programmes", () => {
    const { primary, more } = getSiteNavLinks("owlcognito");
    expect(ids(primary)).toEqual(["courses", "about", "contact", "faqs"]);
    expect(more).toEqual([]);
    const groups = getSiteNavGroups("owlcognito");
    expect(groups.map((group) => group.id)).toEqual(["explore"]);
  });

  it("keeps every previous website link reachable (plus the new track, roadmap and pricing pages)", () => {
    const previous = ["/courses", "/about", "/as-accounts", "/national-desk", "/join-alsyed", "/hall-of-fame", "/contact", "/faqs"];
    const added = ["/tracks/pentesting", "/roadmap", "/pricing"];
    const { primary, more } = getSiteNavLinks("alsyed");
    const internal = (links) => links.filter((link) => !link.external).map((link) => link.to);
    expect(internal([...primary, ...more]).sort()).toEqual([...previous, ...added].sort());
    const sheet = getSiteNavGroups("alsyed").flatMap((group) => group.links);
    expect(internal(sheet).sort()).toEqual([...previous, ...added].sort());
  });

  it("adds Labs (external, Al Syed only) in the centre and in the phone sheet", () => {
    const labs = getSiteNavLinks("alsyed").primary.find((link) => link.id === "labs");
    expect(labs).toMatchObject({ href: LABS_URL, external: true });
    expect(LABS_URL).toBe("https://labs.alsyedinitiative.com");
    expect(getSiteNavGroups("alsyed").flatMap((group) => ids(group.links))).toContain("labs");
    expect(getSiteNavGroups("owlcognito").flatMap((group) => ids(group.links))).not.toContain("labs");
  });

  describe("account menu (driven by capabilities, Appendix A.1)", () => {
    const DJANGO = "https://api.example.com/admin/";
    const ACCOUNT = ["console", "my-courses", "profile", "id-card"];
    const menuFor = (caps) => getAccountMenuGroups({ caps, djangoAdminUrl: DJANGO });
    const linksFor = (caps) => menuFor(caps).flatMap((group) => ids(group.links));
    const linkById = (caps, id) => menuFor(caps).flatMap((group) => group.links).find((link) => link.id === id);

    it("opens the Console first and shows only ungated rows before the capabilities arrive", () => {
      const [account] = menuFor(null);
      expect(account.links[0]).toMatchObject({ id: "console", label: "Open Console", to: "/console" });
      expect(linksFor(null)).toEqual(ACCOUNT);
      expect(linksFor(undefined)).toEqual(ACCOUNT);
    });

    it("gives students their account rows only", () => {
      expect(linksFor(capabilityFixtures.student)).toEqual(ACCOUNT);
    });

    it("shows instructors one disabled Teach row with the server's reason while the section is off", () => {
      const caps = capabilityFixtures.instructor_off;
      expect(linksFor(caps)).toEqual([...ACCOUNT, "teach"]);
      expect(linkById(caps, "teach")).toMatchObject({
        state: "disabled",
        reason: caps.workspaces.teach.reason,
      });
    });

    it("gives instructors the Teach shortcuts once the section is on", () => {
      const caps = capabilityFixtures.instructor_on;
      expect(linksFor(caps)).toEqual([...ACCOUNT, ...TEACH_MENU_LINKS.map((link) => link.id)]);
      expect(linkById(caps, "teach-today")).toMatchObject({ to: "/console/teach", state: "enabled" });
      // A single shortcut the server hides is left out; the others stay.
      const partial = { ...caps, items: { ...caps.items, "teach-grading": { state: "hidden" } } };
      expect(linksFor(partial)).not.toContain("teach-grading");
      expect(linksFor(partial)).toContain("teach-classes");
    });

    it("gives staff Admin and the back office, never the Teach rows, whatever the switch says", () => {
      for (const caps of [capabilityFixtures.staff_off, capabilityFixtures.staff_on]) {
        expect(linksFor(caps)).toEqual([...ACCOUNT, "admin", "back-office"]);
        expect(linkById(caps, "admin")).toMatchObject({ to: SITE_ADMIN_PATH });
        expect(linkById(caps, "back-office")).toMatchObject({ external: true, href: DJANGO });
      }
      expect(SITE_ADMIN_PATH).toBe("/console/admin");
    });

    it("never derives a row from a role flag (no second, drifting gate)", () => {
      const student = capabilityFixtures.student;
      const links = getAccountMenuGroups({ caps: student, isAdmin: true, isInstructor: true }).flatMap((group) => ids(group.links));
      expect(links).toEqual(ACCOUNT);
    });
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
  it("shows guests the centred links, a More menu, Log in and Start learning", () => {
    const html = render();
    expect(html).toContain('<nav class="snav__primary" aria-label="Main">');
    expect(html).toMatch(/<a class="snav__link" href="\/courses"[^>]*>Courses<\/a>/);
    expect(html).toMatch(/<a class="snav__link" href="\/tracks\/pentesting"[^>]*>Pentesting<span class="snav__chip">Soon<\/span><\/a>/);
    expect(html).toMatch(/<a class="snav__menu-item" href="\/about"[^>]*><span>About Us<\/span><\/a>/);
    // More is a keyboard-operable disclosure with its menu in the header (no portal).
    expect(html).toMatch(/<button type="button" class="snav__link snav__more-trigger" aria-expanded="false" aria-controls="[^"]+">More/);
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--more" hidden="">/);
    for (const href of ["/as-accounts", "/join-alsyed", "/hall-of-fame", "/faqs", "/roadmap", "/pricing", "/national-desk", "/contact"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toMatch(/<a class="snav__ghost snav__ghost--bar" href="\/login">Log in<\/a>/);
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar snav__cta--guest" href="\/courses">Start learning<\/a>/);
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
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar" href="\/console">Console<svg/);
    expect(html).toContain('aria-label="Account menu for Asha Rao"');
    expect(html).toContain('<span class="snav__avatar" aria-hidden="true">AR</span>');
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--account" hidden="">/);
    for (const href of ["/console", "/my-courses", "/profile", "/id-card"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("<span>Open Console</span>");
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain('<button type="button" class="snav__icon-btn" aria-label="Open notifications" aria-expanded="false">');
    expect(html).not.toContain(">Sign in<");
    expect(html).not.toContain('class="snav__menu-label">Admin<');
    expect(html).not.toContain('class="snav__menu-label">Teaching<');
    expect(html).not.toMatch(/User(&#x27;|')s Corner/);
  });

  it("lists Admin and the back office for staff (from their capabilities), the back office in a new tab", () => {
    const staff = { ...asha, is_admin: true, capabilities: capabilityFixtures.staff_off };
    const html = render({ auth: { user: staff, isAuthenticated: true, isAdmin: true } });
    expect(html).toContain('<p class="snav__menu-label">Admin</p>');
    expect(html).toMatch(/<a class="snav__menu-item" href="\/console\/admin"[^>]*><span>Admin<\/span><\/a>/);
    expect(html).toMatch(/target="_blank" rel="noopener noreferrer" class="snav__menu-item"><span>Back office<\/span>/);
    for (const href of ["/control-center", "/meeting", "/broadcasting", "/lecture-questions", "/instructor/dashboard"]) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("shows an instructor a focusable, disabled Teach row with the reason while the section is off", () => {
    const caps = capabilityFixtures.instructor_off;
    const html = render({ auth: { user: { ...asha, role: "instructor", capabilities: caps }, isAuthenticated: true, isInstructor: true } });
    expect(html).toMatch(
      /<span class="snav__menu-item is-disabled" role="link" aria-disabled="true" tabindex="0" aria-describedby="([^"]+)"><span class="snav__row-label"><span>Teach<\/span><svg[^>]*>.*?<\/svg><\/span><span id="\1" class="snav__menu-reason">Teaching tools are switched off for now\. An admin can turn them on\.<\/span><\/span>/
    );
    expect(html).not.toContain('href="/console/teach"');
  });

  it("links an instructor's Teach shortcuts once the section is on", () => {
    const caps = capabilityFixtures.instructor_on;
    const html = render({ auth: { user: { ...asha, role: "instructor", capabilities: caps }, isAuthenticated: true, isInstructor: true } });
    for (const href of ["/console/teach", "/console/teach/classes", "/console/teach/grading"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain("is-disabled");
  });

  it("is a g100 Carbon shell with one height in every state (no Tailwind sticky class for brand overrides to hit)", () => {
    const html = render();
    expect(html).toMatch(/^<header class="snav" data-theme="g100" data-scrolled="false" data-hairline="scroll" data-menu-open="false">/);
    // Only the landing melts into the hero; every other page keeps its hairline.
    expect(render({ path: "/courses" })).toContain('data-hairline="always"');
    expect(html).not.toContain("snav__backdrop");
    expect(html).toContain('class="brand-shell snav__brand" href="/"');
  });

  it("puts Labs in the centre as an external link", () => {
    const html = render();
    expect(html).toMatch(/<a href="https:\/\/labs\.alsyedinitiative\.com" target="_blank" rel="noopener noreferrer" class="snav__link">Labs<svg/);
  });
});

describe("Navbar: Watch (YouTube)", () => {
  afterEach(() => {
    youtubeState.current = { status: "idle", model: null, enabled: true };
  });

  it("adds Watch first under More, only where the brand has the channel", () => {
    expect(ids(getSiteNavLinks("alsyed", { youtube: true }).more)[0]).toBe("watch");
    expect(ids(getSiteNavLinks("alsyed").more)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito").primary)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito", { youtube: true }).primary)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
    expect(ids(getSiteNavGroups("alsyed", { youtube: true }).find((group) => group.id === "explore").links)).toEqual(["watch", "about", "contact", "faqs"]);
  });

  it("links Watch to /watch in the More menu", () => {
    const html = render();
    expect(html).toMatch(/<a class="snav__menu-item" href="\/watch"[^>]*><span>Watch<\/span><\/a>/);
    expect(html).not.toContain("snav__live");
  });

  it("derives the Watch state from the brand and the channel", () => {
    expect(getWatchNavState({ brandHasYouTube: false, youtube: { status: "ready", model: liveModel, enabled: true } })).toBe("hidden");
    expect(getWatchNavState({ brandHasYouTube: true, youtube: { status: "ready", model: null, enabled: false } })).toBe("hidden");
    expect(getWatchNavState({ brandHasYouTube: true, youtube: { status: "ready", model: null, enabled: true } })).toBe("disabled");
    expect(getWatchNavState({ brandHasYouTube: true, youtube: { status: "loading", model: null, enabled: true } })).toBe("ready");
    expect(getWatchNavState({ brandHasYouTube: true, youtube: { status: "ready", model: liveModel, enabled: true } })).toBe("live");
  });

  it("disables Watch with \"No videos yet\" when the channel is on but empty (focusable, no href)", () => {
    youtubeState.current = { status: "ready", model: null, enabled: true };
    const html = render();
    expect(html).not.toContain('href="/watch"');
    expect(html).toMatch(
      /<span class="snav__menu-item is-disabled" role="link" aria-disabled="true" tabindex="0" aria-describedby="([^"]+)"><span class="snav__row-label"><span>Watch<\/span><svg[^>]*>.*?<\/svg><\/span><span id="\1" class="snav__menu-reason">No videos yet<\/span><\/span>/
    );
  });

  it("hides Watch once the server says the section is off", () => {
    youtubeState.current = { status: "ready", model: null, enabled: false };
    expect(render()).not.toContain('href="/watch"');
  });

  it("shows the shared LiveDot on Watch while the channel is live", () => {
    youtubeState.current = { status: "ready", model: liveModel, enabled: true };
    const html = render();
    expect(html).toMatch(/<a class="snav__menu-item" href="\/watch"[^>]*><span>Watch<\/span><span class="snav__live"><span class="sc-live-dot[^"]*"[^>]*>.*?<\/span>Live<\/span><\/a>/);
    // The site's private ping keyframes are gone (one LiveDot, M8).
    expect(html).not.toContain("snav__live-dot");
  });

  it("shows the live dot in the phone menu too", async () => {
    youtubeState.current = { status: "ready", model: liveModel, enabled: true };
    // Just enough of a browser for the sheet's effects (the suite runs in Node).
    const noop = () => {};
    vi.stubGlobal("window", {
      scrollY: 0,
      addEventListener: noop,
      removeEventListener: noop,
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
      requestAnimationFrame: () => 0,
    });
    vi.stubGlobal("document", { body: { style: {} }, addEventListener: noop, removeEventListener: noop });
    const tree = await renderTree(
      <AuthContext.Provider value={{ user: null, isAuthenticated: false, isInstructor: false, isAdmin: false, logout: async () => {} }}>
        <StaticRouter location="/about">
          <Navbar />
        </StaticRouter>
      </AuthContext.Provider>
    );
    await fire(tree.getByLabel("button", "Open navigation menu"), "onClick");
    const sheetWatch = tree.find(
      (node) => node.type === "a" && String(node.props.className).includes("snav-sheet__link") && node.props.href === "/watch"
    );
    expect(sheetWatch).not.toBeNull();
    expect(tree.find((node) => node.props?.className === "snav__live")).not.toBeNull();
    await act(async () => {});
    await tree.unmount();
    vi.unstubAllGlobals();
  });
});

describe("Navbar: phone sheet (SideNav under 1024 px)", () => {
  afterEach(() => {
    youtubeState.current = { status: "idle", model: null, enabled: true };
    vi.unstubAllGlobals();
  });

  async function openSheet({ youtube = { status: "idle", model: null, enabled: true }, auth = {} } = {}) {
    youtubeState.current = youtube;
    const noop = () => {};
    const listeners = {};
    const doc = {
      body: { style: {} },
      activeElement: null,
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
      removeEventListener: noop,
    };
    vi.stubGlobal("window", {
      scrollY: 0,
      addEventListener: noop,
      removeEventListener: noop,
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
      requestAnimationFrame: () => 0,
    });
    vi.stubGlobal("document", doc);
    const tree = await renderTree(
      <AuthContext.Provider value={{ user: null, isAuthenticated: false, isInstructor: false, isAdmin: false, logout: async () => {}, ...auth }}>
        <StaticRouter location="/about">
          <Navbar />
        </StaticRouter>
      </AuthContext.Provider>
    );
    const menuButton = tree.getByLabel("button", "Open navigation menu");
    await fire(menuButton, "onClick");
    return { tree, doc, listeners, menuButton };
  }

  const dialogOf = (tree) => tree.find((node) => node.props?.role === "dialog");

  it("opens a modal dialog that locks page scroll, with Labs and the guest actions", async () => {
    const { tree, doc } = await openSheet();
    const dialog = dialogOf(tree);
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.focused).toBe(true);
    expect(doc.body.style.overflow).toBe("hidden");
    const labs = tree.find((node) => node.type === "a" && node.props.href === LABS_URL);
    expect(labs.props.target).toBe("_blank");
    expect(tree.find((node) => node.type === "a" && node.props.href === "/courses" && String(node.props.className).includes("snav__cta--block"))).not.toBeNull();
    await tree.unmount();
  });

  it("closes on Escape and on the scrim, returning focus to the menu button", async () => {
    const { tree, listeners } = await openSheet();
    await act(async () => listeners.keydown({ key: "Escape" }));
    expect(dialogOf(tree)).toBeNull();
    expect(tree.getByLabel("button", "Open navigation menu").focused).toBe(true);

    await fire(tree.getByLabel("button", "Open navigation menu"), "onClick");
    const scrim = tree.find((node) => node.props?.className === "snav-sheet__scrim");
    await fire(scrim, "onClick");
    expect(dialogOf(tree)).toBeNull();
    await tree.unmount();
  });

  it("traps Tab inside the sheet (last wraps to first, Shift+Tab on first wraps to last)", async () => {
    const { tree, doc } = await openSheet();
    const dialog = dialogOf(tree);
    const close = tree.getByLabel("button", "Close navigation menu");
    const last = tree.find((node) => node.type === "a" && node.props.href === "/login" && String(node.props.className).includes("snav__ghost--block"));
    dialog.querySelectorAll = () => [close, last];
    let prevented = 0;
    doc.activeElement = last;
    dialog.props.onKeyDown({ key: "Tab", shiftKey: false, preventDefault: () => (prevented += 1) });
    expect(close.focused).toBe(true);
    doc.activeElement = close;
    dialog.props.onKeyDown({ key: "Tab", shiftKey: true, preventDefault: () => (prevented += 1) });
    expect(last.focused).toBe(true);
    expect(prevented).toBe(2);
    await tree.unmount();
  });

  it("shows Watch as a disabled row with its reason when the channel has no videos", async () => {
    const { tree } = await openSheet({ youtube: { status: "ready", model: null, enabled: true } });
    const dialog = dialogOf(tree);
    const row = tree.find((node) => dialog.contains(node) && node.props?.["aria-disabled"] === "true" && node.props?.role === "link");
    expect(row).not.toBeNull();
    expect(row.props.tabIndex).toBe(0);
    const reason = tree.find((node) => node.props?.id === row.props["aria-describedby"]);
    expect(textOf(reason)).toBe("No videos yet");
    expect(tree.find((node) => dialog.contains(node) && node.type === "a" && node.props.href === "/watch")).toBeNull();
    await tree.unmount();
  });
});
