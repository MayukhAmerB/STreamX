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

describe("site nav model", () => {
  it("puts four key links in the pill and the rest under More for Al syed", () => {
    const { primary, more } = getSiteNavLinks("alsyed");
    expect(ids(primary)).toEqual(["courses", "about", "national-desk", "contact"]);
    expect(ids(more)).toEqual(["accounts", "join", "hall-of-fame", "faqs", "labs"]);
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
    const internal = (links) => links.filter((link) => !link.external).map((link) => link.to);
    expect(internal([...primary, ...more]).sort()).toEqual([...previous].sort());
    const sheet = getSiteNavGroups("alsyed").flatMap((group) => group.links);
    expect(internal(sheet).sort()).toEqual([...previous].sort());
  });

  it("adds Labs (external, Al Syed only) under More and in the phone sheet", () => {
    const labs = getSiteNavLinks("alsyed").more.find((link) => link.id === "labs");
    expect(labs).toMatchObject({ href: LABS_URL, external: true });
    expect(LABS_URL).toBe("https://labs.alsyedinitiative.com");
    expect(getSiteNavGroups("alsyed").flatMap((group) => ids(group.links))).toContain("labs");
    expect(getSiteNavGroups("owlcognito").flatMap((group) => ids(group.links))).not.toContain("labs");
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
    expect(html).toMatch(/<a class="snav__cta snav__cta--bar" href="\/console">Console<svg/);
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

  it("is a g100 Carbon shell with one height in every state (no Tailwind sticky class for brand overrides to hit)", () => {
    const html = render();
    expect(html).toMatch(/^<header class="snav" data-theme="g100" data-scrolled="false" data-menu-open="false">/);
    expect(html).not.toContain("snav__backdrop");
    expect(html).toContain('class="brand-shell snav__brand" href="/"');
  });

  it("puts Labs in the More menu as an external link", () => {
    const html = render();
    expect(html).toMatch(/<a href="https:\/\/labs\.alsyedinitiative\.com" target="_blank" rel="noopener noreferrer" class="snav__menu-item"><span>Labs<\/span>/);
  });
});

describe("Navbar: Watch (YouTube)", () => {
  afterEach(() => {
    youtubeState.current = { status: "idle", model: null, enabled: true };
  });

  it("adds Watch right after Courses, only where the brand has the channel", () => {
    expect(ids(getSiteNavLinks("alsyed", { youtube: true }).primary)).toEqual([
      "courses",
      "watch",
      "about",
      "national-desk",
      "contact",
    ]);
    expect(ids(getSiteNavLinks("alsyed").primary)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito").primary)).not.toContain("watch");
    expect(ids(getSiteNavLinks("owlcognito", { youtube: true }).primary)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
    expect(ids(getSiteNavGroups("alsyed", { youtube: true })[0].links)).toEqual(["courses", "watch", "about", "contact", "faqs"]);
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

  it("shows a pulsing live dot on Watch while the channel is live", () => {
    youtubeState.current = { status: "ready", model: liveModel, enabled: true };
    const html = render();
    expect(html).toMatch(/<a class="snav__link is-live" href="\/watch"[^>]*>Watch<span class="snav__live"><span class="snav__live-dot" aria-hidden="true"><\/span>Live<\/span><\/a>/);
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
