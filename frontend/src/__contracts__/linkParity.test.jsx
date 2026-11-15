// Link-parity contract (plan §7.3, Phase 1A acceptance: "0 removed hrefs").
//
// Renders the public chrome exactly as visitors get it (Navbar, the landing
// page and AppFooter) with mocked API data for a guest, a student, an
// instructor and an admin, opens every menu (More, account, phone sheet),
// and compares the full inventory of hrefs, button labels and anchors, plus
// every route declared in AppRoutes.jsx, with linkParity.fixture.json.
//
// The fixture is hand-maintained. Nothing may disappear. A new href or route
// needs an entry in the fixture's allowlist, and a renamed button needs an
// entry in `renamedButtons`, so every change is an explicit, reviewed diff.
// To print the current inventory (e.g. when reviewing an allowlist change):
//   LINK_PARITY_DUMP=<file outside the repo> npx vitest run src/__contracts__
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthContext } from "../context/AuthContext";
import { livePayload, payload } from "../features/youtube/youtubeFixtures";
import { normalizeYouTubePayload } from "../features/youtube/youtubeModel";
import { act, fire, renderTree } from "../test-utils/renderTree";
import fixture from "./linkParity.fixture.json";
import AppFooter from "../components/AppFooter";
import Navbar from "../components/Navbar";
import LandingPage from "../pages/LandingPage";
import { collectInventory, compareRoutes, compareSurface, parseRoutePaths } from "./linkInventory";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- mocked data

const mocks = vi.hoisted(() => ({ scenario: null }));

const COURSES = [
  {
    id: 101,
    title: "OSINT Professional Program",
    category: "osint",
    level: "beginner",
    launch_status: "live",
    registration_closed: false,
    is_published: true,
    purchase_available: true,
    created_at: "2026-01-05T10:00:00Z",
    average_rating: 4.8,
    review_count: 12,
    lecture_count: 24,
    total_hours: 30,
    instructor: { id: 9, full_name: "Al Syed" },
    hero_countdown_end_at: "2099-01-01T00:00:00Z",
    hero_countdown_label: "Enrollment closes in",
  },
  {
    id: 102,
    title: "OSINT Advanced Investigations",
    category: "osint",
    level: "advanced",
    launch_status: "live",
    registration_closed: false,
    is_published: true,
    purchase_available: true,
    created_at: "2026-02-05T10:00:00Z",
    review_count: 0,
    instructor: { id: 9, full_name: "Al Syed" },
  },
  {
    id: 201,
    title: "Web Application Pentesting Professional",
    category: "web_pentesting",
    level: "intermediate",
    launch_status: "live",
    registration_closed: false,
    is_published: true,
    purchase_available: true,
    created_at: "2026-03-05T10:00:00Z",
    review_count: 1,
    average_rating: 5,
    instructor: { id: 9, full_name: "Al Syed" },
  },
  {
    id: 202,
    title: "Web Application Pentesting Advanced",
    category: "web_pentesting",
    level: "advanced",
    launch_status: "coming_soon",
    registration_closed: true,
    is_published: true,
    purchase_available: false,
    created_at: "2026-04-05T10:00:00Z",
    review_count: 0,
  },
];

// Both tracks open, so both track tiles are links (a disabled track has no href by design).
const TRACKS = [
  { key: "osint", title: "Open Source Intelligence", state: "open", course_count: 2, open_course_count: 2 },
  { key: "web_pentesting", title: "Web Application & API Security", state: "open", course_count: 2, open_course_count: 1 },
];

// One live class per action state (open, pending, view course, closed) plus an owned standalone class.
const LIVE_CLASSES = [
  { id: 11, title: "OSINT Month 1", level: "beginner", month_number: 1, schedule_days: "Friday, Saturday, Sunday", class_duration_minutes: 60, price: 0, enrollment_count: 40, linked_course_id: 101, linked_course_title: "OSINT Professional Program", is_enrolled: true, enrollment_status: "approved" },
  { id: 12, title: "OSINT Month 2", level: "intermediate", month_number: 2, schedule_days: "Friday", class_duration_minutes: 90, price: 2499, enrollment_count: 12, is_enrolled: false, enrollment_status: "pending" },
  { id: 13, title: "Pentesting Month 1", level: "beginner", month_number: 1, schedule_days: "Saturday", class_duration_minutes: 60, price: 0, enrollment_count: 5, linked_course_id: 201, linked_course_title: "Web Application Pentesting Professional", is_enrolled: false, enrollment_status: "none" },
  { id: 14, title: "OSINT Standalone", level: "advanced", month_number: 3, schedule_days: "Sunday", class_duration_minutes: 60, price: 3999, enrollment_count: 0, is_enrolled: false, enrollment_status: "none" },
  { id: 15, title: "OSINT Owned Standalone", level: "advanced", month_number: 4, schedule_days: "Sunday", class_duration_minutes: 60, price: 999, enrollment_count: 3, is_enrolled: true, enrollment_status: "approved" },
];

const envelope = (data, extra = {}) => ({ data: { success: true, message: "", data, errors: null, ...extra } });

vi.mock("../api/courses", async (importOriginal) => ({
  ...(await importOriginal()),
  listCourses: vi.fn(async () => envelope(COURSES, { tracks: TRACKS })),
  listLiveClasses: vi.fn(async () => envelope(LIVE_CLASSES)),
}));

vi.mock("../api/realtime", async (importOriginal) => ({
  ...(await importOriginal()),
  listRealtimeSessions: vi.fn(async () => envelope(mocks.scenario?.sessions || [])),
}));

vi.mock("../api/notifications", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchNotifications: vi.fn(async () => envelope({ results: [], unread_count: 0 })),
  markAllNotificationsRead: vi.fn(async () => envelope({})),
  markNotificationRead: vi.fn(async () => envelope({})),
}));

vi.mock("../features/youtube/youTubeStore", async (importOriginal) => ({
  ...(await importOriginal()),
  useYouTubeChannel: () => mocks.scenario?.youtube || { status: "idle", model: null, enabled: true },
}));

vi.mock("../utils/backendUrl", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveDjangoAdminUrl: () => "https://api.alsyedinitiative.com/admin/",
}));

// ------------------------------------------------------------------ scenarios

const youtubeReady = (data) => ({ status: "ready", model: normalizeYouTubePayload(data), enabled: true });
const user = (overrides) => ({ id: 7, full_name: "Asha Rao", email: "asha.rao@example.com", role: "student", terms_acceptance_required: false, ...overrides });
const liveSession = (overrides = {}) => ({
  id: 55,
  session_type: "broadcasting",
  status: "live",
  stream_status: "live",
  title: "Sunday OSINT live",
  started_at: "2026-11-13T13:00:00Z",
  linked_course: { id: 101 },
  ...overrides,
});

const SCENARIOS = {
  guest: {
    auth: { user: null, isAuthenticated: false, isInstructor: false, isAdmin: false },
    youtube: youtubeReady(payload()),
    sessions: [],
  },
  student: {
    auth: { user: user(), isAuthenticated: true, isInstructor: false, isAdmin: false },
    youtube: youtubeReady(livePayload()),
    sessions: [liveSession()],
  },
  instructor: {
    auth: { user: user({ id: 9, full_name: "Al Syed", role: "instructor" }), isAuthenticated: true, isInstructor: true, isAdmin: false },
    youtube: youtubeReady(payload()),
    // A broadcast with no linked course joins through /join-live.
    sessions: [liveSession({ id: 56, linked_course: null })],
  },
  admin: {
    auth: { user: user({ id: 1, full_name: "Site Admin", is_admin: true }), isAuthenticated: true, isInstructor: false, isAdmin: true },
    youtube: youtubeReady(payload()),
    sessions: [],
  },
};

// ------------------------------------------------------- minimal browser stubs

function installBrowserStubs() {
  const noop = () => {};
  const storage = new Map();
  const target = { addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true };
  const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };
  class IntersectionObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(element) {
      this.callback([{ isIntersecting: true, target: element, intersectionRatio: 1 }], this);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("window", {
    ...target,
    location: { origin: "https://alsyedinitiative.com", hostname: "alsyedinitiative.com", protocol: "https:", pathname: "/", search: "", hash: "", href: "https://alsyedinitiative.com/" },
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 800,
    localStorage,
    sessionStorage: localStorage,
    // No timers fire during the snapshot: polling and countdown ticks are irrelevant to links.
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    scrollTo: noop,
    IntersectionObserver,
    ResizeObserver,
    performance: { now: () => 0 },
  });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("IntersectionObserver", IntersectionObserver);
  vi.stubGlobal("ResizeObserver", ResizeObserver);
  vi.stubGlobal("document", {
    ...target,
    visibilityState: "visible",
    hidden: false,
    activeElement: null,
    title: "",
    body: { style: {}, classList, dataset: {} },
    head: { appendChild: noop },
    documentElement: { style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => "" }, dataset: {}, classList },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute: noop }),
  });
}

// ------------------------------------------------------------------ rendering

const isDialog = (node) => node.props?.role === "dialog";
const surfaceNode = (tree, name) => tree.find((node) => node.props?.["data-surface"] === name);

async function inventoryFor(name) {
  const scenario = SCENARIOS[name];
  mocks.scenario = scenario;
  const auth = { logout: async () => {}, ...scenario.auth };
  const tree = await renderTree(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={["/"]}>
        <div data-surface="navbar">
          <Navbar />
        </div>
        <main data-surface="landing">
          <LandingPage />
        </main>
        <div data-surface="footer">
          <AppFooter />
        </div>
      </MemoryRouter>
    </AuthContext.Provider>
  );
  // Let every mocked request resolve and re-render.
  for (let i = 0; i < 5; i += 1) await act(async () => {});

  // Open the disclosure menus (More, account) so menus rendered only when open are included too.
  const navbar = surfaceNode(tree, "navbar");
  const menuTriggers = tree.all(
    (node) =>
      node.type === "button" &&
      navbar.contains(node) &&
      node.props["aria-expanded"] === false &&
      (String(node.props["aria-label"] || "").startsWith("Account menu for") || node.children.some((child) => child.text === "More"))
  );
  for (const trigger of menuTriggers) await fire(trigger, "onClick");

  const result = {
    navbar: collectInventory(surfaceNode(tree, "navbar"), { skip: isDialog }),
    landing: collectInventory(surfaceNode(tree, "landing")),
    footer: collectInventory(surfaceNode(tree, "footer")),
  };

  // The phone sheet (SideNav under 1024 px).
  await fire(tree.getByLabel("button", "Open navigation menu"), "onClick");
  const sheet = tree.find(isDialog);
  result.navbarSheet = sheet ? collectInventory(sheet) : { hrefs: [], buttons: [], anchors: [] };

  await tree.unmount();
  return result;
}

// ---------------------------------------------------------------------- tests

const SURFACES = ["navbar", "navbarSheet", "landing", "footer"];
const FROZEN_NOW = Date.parse("2026-11-13T12:00:00Z");
const actual = {};

describe("link parity: public navbar, landing page and footer", () => {
  beforeAll(async () => {
    // Freeze the clock: YouTube labels say "published 3 months ago".
    vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
    installBrowserStubs();
    for (const name of Object.keys(SCENARIOS)) actual[name] = await inventoryFor(name);
    actual.routes = parseRoutePaths(fs.readFileSync(path.join(here, "../routes/AppRoutes.jsx"), "utf8"));
    if (process.env.LINK_PARITY_DUMP) {
      fs.writeFileSync(process.env.LINK_PARITY_DUMP, `${JSON.stringify({ routes: actual.routes, scenarios: Object.fromEntries(Object.keys(SCENARIOS).map((name) => [name, actual[name]])) }, null, 2)}\n`);
    }
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    mocks.scenario = null;
  });

  it("covers every scenario and surface in the fixture", () => {
    expect(Object.keys(fixture.scenarios).sort()).toEqual(Object.keys(SCENARIOS).sort());
    for (const name of Object.keys(SCENARIOS)) {
      expect(Object.keys(fixture.scenarios[name]).sort()).toEqual([...SURFACES].sort());
    }
  });

  it("keeps every route declared in AppRoutes.jsx", () => {
    expect(compareRoutes(fixture.routes, actual.routes, fixture.allowedRouteAdditions)).toEqual([]);
  });

  for (const name of Object.keys(SCENARIOS)) {
    it(`keeps every href, button and anchor for the ${name} scenario`, () => {
      const problems = SURFACES.flatMap((surface) =>
        compareSurface(`${name}.${surface}`, fixture.scenarios[name][surface], actual[name][surface], {
          allowedHrefAdditions: fixture.allowedHrefAdditions[surface] || [],
          allowedHrefRemovals: fixture.allowedHrefRemovals?.[surface] || [],
          renamedButtons: fixture.renamedButtons || {},
          requiredAnchors: fixture.requiredAnchors[surface] || [],
        })
      );
      expect(problems).toEqual([]);
    });
  }

  it("keeps the landing anchors #watch and #about and the footer anchor #contact", () => {
    expect(actual.guest.landing.anchors).toEqual(expect.arrayContaining(["watch", "about"]));
    expect(actual.guest.footer.anchors).toContain("contact");
  });

  it("only allows the planned additions (Labs, National Desk, AS-Accounts, Join Al Syed, the HackPath nav)", () => {
    const labs = "https://labs.alsyedinitiative.com";
    // HackPath-style redesign (b03f085a): Pricing, Roadmap and the Tracks pages.
    const hackpathNav = ["/pricing", "/roadmap", "/tracks/pentesting"];
    expect(fixture.allowedHrefAdditions.navbar).toEqual([labs, ...hackpathNav]);
    expect(fixture.allowedHrefAdditions.navbarSheet).toEqual([labs, ...hackpathNav]);
    expect([...fixture.allowedHrefAdditions.footer].sort()).toEqual(
      [labs, "/as-accounts", "/join-alsyed", "/national-desk", "/pricing", "/roadmap", "/tracks/osint", "/tracks/pentesting"].sort()
    );
    expect([...fixture.allowedHrefAdditions.landing].sort()).toEqual(
      ["/about", "/hall-of-fame", "/osint/free", "/pricing", "/roadmap", "/tracks/osint", "/tracks/pentesting"].sort()
    );
    expect([...fixture.allowedRouteAdditions].sort()).toEqual(
      [
        "/reset-password",
        "/pricing",
        "/roadmap",
        "/tracks/:track",
        "/bootcamp",
        "/osint/free",
        "/monthly-ctf",
        "/monthly-ctf/hall-of-fame",
        "/monthly-ctf/certificates/:slug",
        "/monthly-ctf/play",
      ].sort()
    );
    // A removal never reaches the footer, and every removed in-app target is still a route.
    expect(fixture.allowedHrefRemovals.footer).toEqual([]);
    const removed = ["navbar", "navbarSheet", "landing"].flatMap((surface) => fixture.allowedHrefRemovals[surface]);
    for (const href of removed.filter((item) => item.startsWith("/"))) {
      const pathname = href.split(/[?#]/)[0];
      const routes = actual.routes.map((route) => (route === "CONSOLE_PATH" ? "/console" : route));
      const known = routes.some((route) => route === pathname || (route.includes(":") && new RegExp(`^${route.replace(/:[^/]+/g, "[^/]+")}$`).test(pathname)));
      expect(known, `${href} is still routed`).toBe(true);
    }
  });
});

describe("link parity: comparison rules", () => {
  const base = { hrefs: ["/a", "/b"], buttons: ["More"], anchors: ["about"] };

  it("flags a removed href, an unlisted addition and a removed anchor", () => {
    const problems = compareSurface("s", base, { hrefs: ["/a", "/new"], buttons: ["More"], anchors: [] }, { requiredAnchors: ["about"] });
    expect(problems).toEqual(["s: href removed: /b", "s: href added without allowlist entry: /new", "s: anchor removed: #about"]);
  });

  it("accepts allowlisted additions and explicit button renames only when the new label renders", () => {
    const renamed = { hrefs: ["/a", "/b", "/labs"], buttons: ["Menu"], anchors: ["about"] };
    expect(compareSurface("s", base, renamed, { allowedHrefAdditions: ["/labs"], renamedButtons: { More: "Menu" } })).toEqual([]);
    expect(compareSurface("s", base, { ...renamed, buttons: [] }, { allowedHrefAdditions: ["/labs"], renamedButtons: { More: "Menu" } })).toEqual([
      's: button "More" was renamed to "Menu" in the fixture, but "Menu" is not rendered',
    ]);
  });

  it("accepts only the reviewed href removals", () => {
    const current = { hrefs: ["/a"], buttons: ["More"], anchors: ["about"] };
    expect(compareSurface("s", base, current, { allowedHrefRemovals: ["/b"] })).toEqual([]);
    expect(compareSurface("s", base, current, { allowedHrefRemovals: ["/c"] })).toEqual(["s: href removed: /b"]);
  });

  it("reads the routes of a legacy route group but not its loop variable", () => {
    const source = '{entries.map(([path]) => <Route path={path} />)}[["/old", <Old key="o" />], ["/older/:id", <Older key="p" />]]';
    expect(parseRoutePaths(source)).toEqual(["/old", "/older/:id"]);
  });

  it("parses literal and expression route paths and rejects removed or unlisted routes", () => {
    const routes = parseRoutePaths('<Route path="/" /><Route path={CONSOLE_PATH} /><Route path={`${LEGACY}/*`} /><Route path="/" />');
    expect(routes).toEqual(["/", "CONSOLE_PATH", "${LEGACY}/*"]);
    expect(compareRoutes(["/", "/gone"], ["/", "/extra"], [])).toEqual(["routes: route removed: /gone", "routes: route added without allowlist entry: /extra"]);
  });
});
