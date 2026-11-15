import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("site nav model (the previous production navbar, 7a444898)", () => {
  it("puts Courses, Watch, About Us, National Desk and Contact in the pill and the rest under More for Al Syed", () => {
    const { primary, more } = getSiteNavLinks("alsyed", { youtube: true });
    expect(ids(primary)).toEqual(["courses", "watch", "about", "national-desk", "contact"]);
    expect(ids(more)).toEqual(["accounts", "join", "hall-of-fame", "faqs"]);
    expect(more.map((link) => link.label)).toEqual(["AS-Accounts", "Join Al Syed", "Hall of Fame", "FAQs"]);
    // Without the channel, Watch is simply left out.
    expect(ids(getSiteNavLinks("alsyed").primary)).toEqual(["courses", "about", "national-desk", "contact"]);
  });

  it("keeps Pentesting, Roadmap, Labs and Pricing out of the top level (Courses, footer and landing reach them)", () => {
    const { primary, more } = getSiteNavLinks("alsyed", { youtube: true });
    const sheet = getSiteNavGroups("alsyed", { youtube: true }).flatMap((group) => group.links);
    for (const link of [...primary, ...more, ...sheet]) {
      expect(["pentesting", "roadmap", "labs", "pricing"]).not.toContain(link.id);
      expect(link.external).toBeFalsy();
    }
    // Still exported for the footer and the free labs page.
    expect(LABS_URL).toBe("https://labs.alsyedinitiative.com");
  });

  it("shows OwlCognito's links without a More menu or Al Syed programmes (brandOnly)", () => {
    const { primary, more } = getSiteNavLinks("owlcognito");
    expect(ids(primary)).toEqual(["courses", "about", "contact", "faqs"]);
    expect(more).toEqual([]);
    const groups = getSiteNavGroups("owlcognito");
    expect(groups.map((group) => group.id)).toEqual(["explore"]);
  });

  it("groups the phone sheet into Explore and Al Syed", () => {
    const groups = getSiteNavGroups("alsyed", { youtube: true });
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ["explore", "Explore"],
      ["community", "Al Syed"],
    ]);
    expect(ids(groups[0].links)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
    expect(ids(groups[1].links)).toEqual(["national-desk", "accounts", "join", "hall-of-fame"]);
  });

  it("keeps every previous website link reachable in the bar and in the sheet", () => {
    const previous = ["/courses", "/watch", "/about", "/as-accounts", "/national-desk", "/join-alsyed", "/hall-of-fame", "/contact", "/faqs"];
    const { primary, more } = getSiteNavLinks("alsyed", { youtube: true });
    expect([...primary, ...more].map((link) => link.to).sort()).toEqual([...previous].sort());
    const sheet = getSiteNavGroups("alsyed", { youtube: true }).flatMap((group) => group.links);
    expect(sheet.map((link) => link.to).sort()).toEqual([...previous].sort());
  });

  describe("account menu (role-gated like the previous navbar)", () => {
    const DJANGO = "https://api.example.com/admin/";
    const ACCOUNT = ["console", "my-courses", "guides", "profile", "id-card"];
    const linksFor = (flags) => getAccountMenuGroups({ djangoAdminUrl: DJANGO, ...flags }).flatMap((group) => ids(group.links));

    it("gives everyone Console, My courses, Guides, Profile and ID Card", () => {
      const [account] = getAccountMenuGroups();
      expect(account.links.map((link) => link.label)).toEqual(["Console", "My courses", "Guides", "Profile", "ID Card"]);
      expect(account.links[0]).toMatchObject({ id: "console", to: "/console" });
      expect(linksFor({})).toEqual(ACCOUNT);
    });

    it("adds the instructor dashboard and the meeting/broadcast controls for instructors", () => {
      expect(linksFor({ isInstructor: true })).toEqual([...ACCOUNT, "instructor", "meeting", "broadcasting"]);
    });

    it("adds the controls, lecture questions and the Django admin (new tab) for admins", () => {
      expect(linksFor({ isAdmin: true })).toEqual([...ACCOUNT, "control-center", "meeting", "broadcasting", "lecture-questions", "django-admin"]);
      const django = getAccountMenuGroups({ isAdmin: true, djangoAdminUrl: DJANGO })
        .flatMap((group) => group.links)
        .find((link) => link.id === "django-admin");
      expect(django).toMatchObject({ href: DJANGO, external: true });
      // No URL, no row.
      expect(getAccountMenuGroups({ isAdmin: true }).flatMap((group) => ids(group.links))).not.toContain("django-admin");
    });
  });

  it("matches active links by path prefix and builds initials", () => {
    expect(isSiteLinkActive({ to: "/courses" }, "/courses/12")).toBe(true);
    expect(isSiteLinkActive({ to: "/courses" }, "/courses-x")).toBe(false);
    expect(isSiteLinkActive({ to: "/faqs" }, "/faqs/?q=1")).toBe(true);
    expect(isSiteLinkActive({ href: "https://x.test" }, "/")).toBe(false);
    expect(getInitials({ full_name: "Asha Rao" })).toBe("AR");
    expect(getInitials({ full_name: "Asha" })).toBe("A");
    expect(getInitials({ email: "zed@example.com" })).toBe("Z");
    expect(getInitials(null)).toBe("?");
    expect(getShortName({ full_name: "Asha Rao" })).toBe("Asha");
    expect(getShortName({ email: "zed@example.com" })).toBe("zed");
  });
});

describe("Navbar", () => {
  it("shows guests the centred pill, a More menu, Log in and Start learning", () => {
    const html = render();
    expect(html).toContain('<nav class="snav__primary" aria-label="Main">');
    expect(html).toMatch(/<a class="snav__link" href="\/courses"[^>]*>Courses<\/a>/);
    expect(html).toMatch(/<a class="snav__link" href="\/about"[^>]*>About<\/a>/);
    expect(html).toMatch(/<a class="snav__link" href="\/national-desk"[^>]*>National Desk<\/a>/);
    expect(html).toMatch(/<a class="snav__link" href="\/contact"[^>]*>Contact<\/a>/);
    expect(html).toMatch(/<a class="snav__menu-item" href="\/as-accounts"[^>]*><span>AS-Accounts<\/span><\/a>/);
    // More is a keyboard-operable disclosure with its menu in the header (no portal).
    expect(html).toMatch(/<button type="button" class="snav__link snav__more-trigger" aria-expanded="false" aria-controls="[^"]+">More/);
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--more" hidden="">/);
    for (const href of ["/as-accounts", "/join-alsyed", "/hall-of-fame", "/faqs"]) {
      expect(html).toContain(`href="${href}"`);
    }
    for (const href of ["/tracks/pentesting", "/roadmap", "/pricing", LABS_URL]) {
      expect(html).not.toContain(`href="${href}"`);
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
    expect(render({ path: "/national-desk" })).toMatch(/<a aria-current="page" class="snav__link is-active" href="\/national-desk"/);
    expect(render({ path: "/hall-of-fame" })).toContain('class="snav__link snav__more-trigger is-active"');
    expect(render({ path: "/" })).not.toContain("is-active");
  });

  it("gives signed-in users the Console button, the bell and the avatar menu", () => {
    const html = render({ auth: { user: asha, isAuthenticated: true } });
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar" href="\/console">Console<svg/);
    expect(html).toContain('aria-label="Account menu for Asha Rao"');
    expect(html).toContain('<span class="snav__avatar" aria-hidden="true">AR</span>');
    expect(html).toMatch(/<div id="[^"]+" class="snav__menu snav__menu--account" hidden="">/);
    for (const href of ["/console", "/my-courses", "/guides", "/profile", "/id-card"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("<span>ID Card</span>");
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain('<button type="button" class="snav__icon-btn" aria-label="Open notifications" aria-expanded="false">');
    expect(html).not.toContain(">Log in<");
    expect(html).not.toContain('class="snav__menu-label">Staff tools<');
  });

  it("lists the staff tools for admins, the Django admin in a new tab", () => {
    const staff = { ...asha, is_admin: true };
    const html = render({ auth: { user: staff, isAuthenticated: true, isAdmin: true } });
    expect(html).toContain('<p class="snav__menu-label">Staff tools</p>');
    for (const href of ["/control-center", "/meeting", "/broadcasting", "/lecture-questions"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain('href="/instructor/dashboard"');
    expect(html).toMatch(/target="_blank" rel="noopener noreferrer" class="snav__menu-item"><span>Django Admin<\/span>/);
  });

  it("gives instructors the instructor dashboard and the controls, never lecture questions or Django", () => {
    const html = render({ auth: { user: { ...asha, role: "instructor" }, isAuthenticated: true, isInstructor: true } });
    for (const href of ["/instructor/dashboard", "/meeting", "/broadcasting"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain('href="/lecture-questions"');
    expect(html).not.toContain("Django Admin");
  });

  it("is one sticky bar with one height in every state", () => {
    const html = render();
    expect(html).toMatch(/^<header class="snav" data-theme="g100" data-scrolled="false" data-hairline="scroll" data-menu-open="false">/);
    // Only the landing melts into the hero; every other page keeps its hairline.
    expect(render({ path: "/courses" })).toContain('data-hairline="always"');
    expect(html).toContain('class="brand-shell snav__brand" href="/"');
  });
});

describe("Navbar: Watch (YouTube)", () => {
  afterEach(() => {
    youtubeState.current = { status: "idle", model: null, enabled: true };
  });

  it("puts Watch right after Courses in the pill, only where the brand has the channel", () => {
    expect(ids(getSiteNavLinks("alsyed", { youtube: true }).primary)[1]).toBe("watch");
    expect(ids(getSiteNavLinks("alsyed").primary)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito").primary)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito", { youtube: true }).primary)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
    expect(ids(getSiteNavGroups("alsyed", { youtube: true }).find((group) => group.id === "explore").links)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
  });

  it("links Watch to /watch in the pill", () => {
    const html = render();
    expect(html).toMatch(/<a class="snav__link" href="\/watch"[^>]*>Watch<\/a>/);
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
      /<span class="snav__link is-disabled" role="link" aria-disabled="true" tabindex="0" aria-describedby="([^"]+)">Watch<span id="\1" role="tooltip" class="snav__tooltip">No videos yet<\/span><\/span>/
    );
  });

  it("hides Watch once the server says the section is off", () => {
    youtubeState.current = { status: "ready", model: null, enabled: false };
    expect(render()).not.toContain('href="/watch"');
  });

  it("shows the shared LiveDot on Watch while the channel is live", () => {
    youtubeState.current = { status: "ready", model: liveModel, enabled: true };
    const html = render();
    expect(html).toMatch(/<a class="snav__link is-live" href="\/watch"[^>]*>Watch<span class="snav__live"><span class="sc-live-dot[^"]*"[^>]*>.*?<\/span>Live<\/span><\/a>/);
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

  it("opens a modal dialog that locks page scroll, with Explore, Al Syed and the guest actions", async () => {
    const { tree, doc, menuButton } = await openSheet();
    const dialog = dialogOf(tree);
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props["aria-labelledby"]).toBeTruthy();
    expect(dialog.focused).toBe(true);
    expect(menuButton.props["aria-haspopup"]).toBe("dialog");
    expect(doc.body.style.overflow).toBe("hidden");
    const labels = tree.all((node) => node.props?.className === "snav-sheet__label").map(textOf);
    expect(labels).toEqual(["Explore", "Al Syed"]);
    for (const href of ["/courses", "/watch", "/about", "/contact", "/faqs", "/national-desk", "/as-accounts", "/join-alsyed", "/hall-of-fame"]) {
      expect(tree.find((node) => dialog.contains(node) && node.type === "a" && node.props.href === href)).not.toBeNull();
    }
    expect(tree.find((node) => node.type === "a" && node.props.href === LABS_URL)).toBeNull();
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
