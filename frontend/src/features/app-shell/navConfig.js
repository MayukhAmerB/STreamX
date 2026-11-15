// Pure navigation model for the functional (logged-in) app shell.
// Kept free of React and Carbon imports so it can be unit tested in plain Node
// and reused by later phases (instructor/moderator pages, mobile app parity).

export const ROLE_STUDENT = "student";
export const ROLE_INSTRUCTOR = "instructor";
export const ROLE_MODERATOR = "moderator";
export const ROLE_ADMIN = "admin";

export const BOTTOM_NAV_LIMIT = 4;
export const MORE_ITEM_ID = "more";

/** The whole logged-in area is branded "Console"; this is its home. */
export const CONSOLE_TITLE = "Console";
export const CONSOLE_PATH = "/console";
/**
 * The Console's old address. Links to it were shared before the rename, so
 * the router keeps it as a permanent redirect to CONSOLE_PATH.
 */
export const LEGACY_CONSOLE_PATH = "/users-corner";

/**
 * The OSINT CTF lab: a standalone public site on its own subdomain (no SSO),
 * so it is an external link that opens in a new tab. Al syed only.
 */
export const LABS_URL = "https://labs.alsyedinitiative.com";
export const BRAND_ALSYED = "alsyed";

/**
 * Every destination the shell can show. `icon` is a key resolved to a Carbon
 * icon component by navIcons.js. `bottomNav` marks the phone tab bar items
 * (in order); everything else lives in the "More" sheet on phones.
 */
export const NAV_ITEMS = [
  {
    id: "overview",
    section: "learn",
    label: "Overview",
    shortLabel: "Overview",
    to: CONSOLE_PATH,
    icon: "overview",
    hint: "Your progress at a glance",
    match: [/^\/console\/?$/],
    bottomNav: true,
  },
  {
    id: "my-courses",
    section: "learn",
    label: "My courses",
    shortLabel: "Courses",
    to: "/my-courses",
    icon: "courses",
    hint: "Pick up where you left off",
    match: [/^\/my-courses\/?$/],
    bottomNav: true,
  },
  {
    id: "continue-learning",
    section: "learn",
    label: "Continue learning",
    shortLabel: "Learn",
    to: "/my-courses",
    icon: "continue",
    hint: "Resume your last lesson",
    match: [/^\/learn\//],
    bottomNav: true,
  },
  {
    id: "live-classes",
    section: "learn",
    label: "Live classes",
    shortLabel: "Live",
    to: "/join-live",
    icon: "live",
    hint: "Join and schedule classes",
    match: [/^\/join-live\/?$/, /^\/courses\/[^/]+\/live\/?$/],
    bottomNav: true,
  },
  {
    id: "reports",
    section: "learn",
    label: "Reports",
    shortLabel: "Reports",
    to: "/reports",
    icon: "reports",
    hint: "Weekly targets and your marks",
    match: [/^\/reports(\/.*)?$/],
  },
  {
    id: "guides",
    section: "learn",
    label: "Guides",
    shortLabel: "Guides",
    to: "/guides",
    icon: "guides",
    hint: "Short how-to videos",
    match: [/^\/guides\/?$/],
  },
  {
    id: "osint-tools",
    section: "learn",
    label: "OSINT tools",
    shortLabel: "Tools",
    to: "/osint-tools",
    icon: "tools",
    hint: "Your investigation toolkit",
    match: [/^\/osint-tools\/?$/],
  },
  {
    id: "labs",
    section: "learn",
    label: "Labs",
    shortLabel: "Labs",
    href: LABS_URL,
    external: true,
    icon: "labs",
    hint: "Practice OSINT challenges",
    brands: [BRAND_ALSYED],
  },
  {
    id: "profile",
    section: "account",
    label: "Profile",
    shortLabel: "Profile",
    to: "/profile",
    icon: "profile",
    hint: "Name, photo and password",
    match: [/^\/profile\/?$/],
  },
  {
    id: "id-card",
    section: "account",
    label: "ID card",
    shortLabel: "ID card",
    to: "/id-card",
    icon: "idCard",
    hint: "Your student ID",
    match: [/^\/id-card\/?$/],
  },
  {
    id: "instructor-dashboard",
    section: "teach",
    label: "Instructor dashboard",
    shortLabel: "Instructor",
    to: "/instructor/dashboard",
    icon: "instructor",
    hint: "Manage your courses",
    match: [/^\/instructor\/dashboard\/?$/, /^\/instructor\/courses\/[^/]+\/edit\/?$/],
    roles: [ROLE_INSTRUCTOR],
  },
  {
    id: "new-course",
    section: "teach",
    label: "New course",
    shortLabel: "New course",
    to: "/instructor/courses/new",
    icon: "add",
    hint: "Create and publish a course",
    match: [/^\/instructor\/courses\/new\/?$/],
    roles: [ROLE_INSTRUCTOR],
  },
  {
    id: "report-grading",
    section: "teach",
    label: "Report grading",
    shortLabel: "Grading",
    to: "/report-grading",
    icon: "grading",
    hint: "Set weekly targets and mark reports",
    match: [/^\/report-grading(\/.*)?$/],
    roles: [ROLE_MODERATOR],
  },
  {
    id: "control-center",
    section: "teach",
    label: "Control center",
    shortLabel: "Control",
    to: "/control-center",
    icon: "dashboard",
    hint: "Platform operations",
    match: [/^\/control-center\/?$/],
    roles: [ROLE_MODERATOR],
  },
  {
    id: "meeting",
    section: "teach",
    label: "Meeting room",
    shortLabel: "Meeting",
    to: "/meeting",
    icon: "meeting",
    hint: "Host an interactive class",
    match: [/^\/meeting\/?$/],
    roles: [ROLE_MODERATOR],
  },
  {
    id: "broadcasting",
    section: "teach",
    label: "Broadcasting",
    shortLabel: "Broadcast",
    to: "/broadcasting",
    icon: "broadcast",
    hint: "Stream to every student",
    match: [/^\/broadcasting\/?$/],
    roles: [ROLE_MODERATOR],
  },
  {
    id: "lecture-questions",
    section: "teach",
    label: "Lecture questions",
    shortLabel: "Questions",
    to: "/lecture-questions",
    icon: "questions",
    hint: "Answer student questions",
    match: [/^\/lecture-questions\/?$/],
    roles: [ROLE_ADMIN],
  },
];

export const NAV_SECTIONS = [
  { id: "learn", label: "Learn" },
  { id: "account", label: "Account" },
  { id: "teach", label: "Teaching" },
];

/**
 * Pages already rebuilt with Carbon components. Every other shell route is
 * rendered inside the legacy (dark, Tailwind) frame until it is migrated.
 * Phases 3-4 add their routes here as they are overhauled.
 */
export const CARBON_NATIVE_PATHS = [
  /^\/console\/?$/,
  /^\/my-courses\/?$/,
  /^\/profile\/?$/,
  /^\/learn\/[^/]+\/?$/,
  /^\/guides\/?$/,
  /^\/osint-tools\/?$/,
  /^\/id-card\/?$/,
  /^\/join-live\/?$/,
  /^\/courses\/[^/]+\/live\/?$/,
  // Weekly reports (students) and report grading (instructors, admins).
  /^\/reports(\/.*)?$/,
  /^\/report-grading(\/.*)?$/,
];

/**
 * Carbon pages that manage their own edge-to-edge layout (the course
 * player's video runs full width on phones), so the shell drops the
 * centred reading width and page padding for them.
 */
export const CARBON_FLUSH_PATHS = [
  /^\/learn\/[^/]+\/?$/,
  // Live classes: the class video runs edge to edge on phones.
  /^\/join-live\/?$/,
  /^\/courses\/[^/]+\/live\/?$/,
];

/** Maps the AuthContext flags to the role set used by the nav config. */
export function getUserRoles(auth = {}) {
  const roles = new Set([ROLE_STUDENT]);
  const isInstructor = Boolean(auth?.isInstructor || auth?.user?.role === "instructor");
  const isAdmin = Boolean(auth?.isAdmin || auth?.user?.is_admin);
  if (isInstructor) roles.add(ROLE_INSTRUCTOR);
  if (isAdmin) roles.add(ROLE_ADMIN);
  // Mirrors ProtectedRoute's requireModerator rule (instructor or admin).
  if (isInstructor || isAdmin) roles.add(ROLE_MODERATOR);
  return roles;
}

export function canSeeNavItem(item, roles, brandId = BRAND_ALSYED) {
  if (item?.brands?.length && !item.brands.includes(brandId)) return false;
  if (!item?.roles || item.roles.length === 0) return true;
  return item.roles.some((role) => roles.has(role));
}

/** External destinations (Labs) open another site in a new tab. */
export function isExternalNavItem(item) {
  return Boolean(item?.external && item?.href);
}

/** "Continue learning" resumes the last opened course, else the library. */
export function resolveContinueLearningPath(lastCourseId) {
  const id = String(lastCourseId ?? "").trim();
  return /^\d+$/.test(id) ? `/learn/${id}` : "/my-courses";
}

/** Extracts the course id from a /learn/:courseId path, or "". */
export function getLearnCourseId(pathname = "") {
  const match = /^\/learn\/(\d+)(?:\/|$)/.exec(String(pathname));
  return match ? match[1] : "";
}

/**
 * All destinations the current user may see, with dynamic paths resolved.
 * `brandId` is the site brand (siteBrand.id); brand-only items such as Labs
 * are dropped for other brands.
 */
export function getNavItems(auth = {}, { lastCourseId = "", brandId = BRAND_ALSYED } = {}) {
  const roles = getUserRoles(auth);
  return NAV_ITEMS.filter((item) => canSeeNavItem(item, roles, brandId)).map((item) =>
    item.id === "continue-learning"
      ? { ...item, to: resolveContinueLearningPath(lastCourseId) }
      : item
  );
}

/** Items grouped by section for the desktop side nav (empty sections dropped). */
export function getNavSections(auth = {}, options = {}) {
  const items = getNavItems(auth, options);
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((item) => item.section === section.id),
  })).filter((section) => section.items.length > 0);
}

/** Internal routes only: an external link is never the current page. */
export function isNavItemActive(item, pathname = "") {
  if (isExternalNavItem(item)) return false;
  const path = String(pathname || "").split(/[?#]/)[0];
  return Boolean(item?.match?.some((pattern) => pattern.test(path)));
}

export function getActiveNavItemId(items = [], pathname = "") {
  const active = items.find((item) => isNavItemActive(item, pathname));
  return active ? active.id : "";
}

/** Phone tab bar: up to BOTTOM_NAV_LIMIT primary items + "More". */
export function getBottomNavItems(items = []) {
  return items.filter((item) => item.bottomNav).slice(0, BOTTOM_NAV_LIMIT);
}

/** Everything not in the tab bar goes into the "More" sheet. */
export function getMoreItems(items = []) {
  const primaryIds = new Set(getBottomNavItems(items).map((item) => item.id));
  return items.filter((item) => !primaryIds.has(item.id));
}

/** True when the active route lives in the More sheet (so "More" shows active). */
export function isMoreActive(items = [], pathname = "") {
  return getMoreItems(items).some((item) => isNavItemActive(item, pathname));
}

export function isFlushPage(pathname = "") {
  const path = String(pathname || "").split(/[?#]/)[0];
  return CARBON_FLUSH_PATHS.some((pattern) => pattern.test(path));
}

export function getShellPageMode(pathname = "") {
  const path = String(pathname || "").split(/[?#]/)[0];
  return CARBON_NATIVE_PATHS.some((pattern) => pattern.test(path)) ? "carbon" : "legacy";
}

/**
 * Browser tab title inside the shell: "<page> · Console" (the Overview hub
 * is just "Console").
 */
export function getShellDocumentTitle(items = [], pathname = "") {
  const active = (items || []).find((item) => isNavItemActive(item, pathname));
  if (!active || active.id === "overview") return CONSOLE_TITLE;
  return `${active.label} · ${CONSOLE_TITLE}`;
}

/**
 * Big icon tiles on the Console hub: every destination the user may open
 * (except the hub itself and the "Continue learning" shortcut, which has its
 * own card), grouped into "Shortcuts" and "Teaching".
 */
export function getCornerTileGroups(auth = {}, options = {}) {
  const items = getNavItems(auth, options).filter(
    (item) => item.id !== "overview" && item.id !== "continue-learning"
  );
  return [
    { id: "corner", label: "Shortcuts", items: items.filter((item) => item.section !== "teach") },
    { id: "teach", label: "Teaching", items: items.filter((item) => item.section === "teach") },
  ].filter((group) => group.items.length > 0);
}
