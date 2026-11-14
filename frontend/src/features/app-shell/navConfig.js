// Pure navigation model for the Console shell (UI overhaul plan §3.1-§3.3,
// §4.2). OWNER: WS-B. Free of React and Carbon imports so it can be unit
// tested in plain Node and reused (command palette destinations, mobile app
// parity).
//
// Three workspaces; a viewer sees only the ones they can use:
//   learn  everyone
//   teach  non-staff instructors, gated by the `teaching` feature
//          (default off: the segment is shown disabled with the reason)
//   admin  staff, never gated by any switch
// Staff never see Teach (their tools live in Admin), so the switch is
// always two segments: Learn | Teach or Learn | Admin. Students see none.

export const ROLE_STUDENT = "student";
export const ROLE_INSTRUCTOR = "instructor";
export const ROLE_MODERATOR = "moderator";
export const ROLE_ADMIN = "admin";

export const BOTTOM_NAV_LIMIT = 4;
export const MORE_ITEM_ID = "more";

/** The signed-in area is the "Console"; this is its home. */
export const CONSOLE_TITLE = "Console";
export const CONSOLE_PATH = "/console";
/** The Console's old address (kept as a permanent redirect to CONSOLE_PATH). */
export const LEGACY_CONSOLE_PATH = "/users-corner";

/** The OSINT CTF lab: a standalone site (no SSO), opened in a new tab. Al Syed only. */
export const LABS_URL = "https://labs.alsyedinitiative.com";
export const BRAND_ALSYED = "alsyed";

export const TEACH_ROOT = "/console/teach";
export const ADMIN_ROOT = "/console/admin";

export const WORKSPACE_LEARN = "learn";
export const WORKSPACE_TEACH = "teach";
export const WORKSPACE_ADMIN = "admin";

export const WORKSPACES = Object.freeze({
  learn: { key: WORKSPACE_LEARN, label: "Learn", home: CONSOLE_PATH },
  teach: { key: WORKSPACE_TEACH, label: "Teach", home: TEACH_ROOT },
  admin: { key: WORKSPACE_ADMIN, label: "Admin", home: ADMIN_ROOT },
});

/** Shown while capabilities load, so a gated item never flashes enabled. */
export const CHECKING_REASON = "Checking…";
export const TEACHING_OFF_REASON = "Teaching tools are switched off for now. An admin can turn them on.";

const BACK_OFFICE = "/admin/";

// ---------------------------------------------------------------------------
// Learn (everyone). `bottomNav` marks the phone tab bar items, in order.
// ---------------------------------------------------------------------------
export const LEARN_ITEMS = Object.freeze([
  {
    id: "home",
    workspace: WORKSPACE_LEARN,
    section: "main",
    label: "Home",
    shortLabel: "Home",
    to: CONSOLE_PATH,
    icon: "home",
    hint: "What to do next",
    match: [/^\/console\/?$/],
    bottomNav: true,
  },
  {
    id: "courses",
    workspace: WORKSPACE_LEARN,
    section: "main",
    label: "Courses",
    shortLabel: "Courses",
    to: "/my-courses",
    icon: "courses",
    hint: "Your courses and lessons",
    match: [/^\/my-courses\/?$/, /^\/learn\/[^/]+/],
    bottomNav: true,
  },
  {
    id: "live",
    workspace: WORKSPACE_LEARN,
    section: "main",
    label: "Live classes",
    shortLabel: "Live",
    to: "/join-live",
    icon: "live",
    hint: "Join your live classes",
    match: [/^\/join-live\/?$/, /^\/courses\/[^/]+\/live\/?$/],
    bottomNav: true,
    signal: "live",
  },
  {
    id: "coursework",
    workspace: WORKSPACE_LEARN,
    section: "main",
    label: "Coursework",
    shortLabel: "Work",
    to: "/reports",
    icon: "coursework",
    hint: "Reports, grades and exams",
    match: [/^\/reports(?:\/.*)?$/, /^\/gradebook\/?$/, /^\/coursework(?:\/.*)?$/],
    bottomNav: true,
    signal: "coursework",
  },
  {
    id: "guides",
    workspace: WORKSPACE_LEARN,
    section: "main",
    label: "Guides",
    shortLabel: "Guides",
    to: "/guides",
    icon: "guides",
    hint: "Short how-to videos",
    match: [/^\/guides\/?$/],
    // Hidden while there are no guides (the shell passes guidesAvailable: false).
    optional: "guides",
  },
  {
    id: "osint-tools",
    workspace: WORKSPACE_LEARN,
    section: "practice",
    label: "OSINT tools",
    shortLabel: "Tools",
    to: "/osint-tools",
    icon: "tools",
    hint: "Your investigation toolkit",
    match: [/^\/osint-tools\/?$/],
  },
  {
    id: "labs",
    workspace: WORKSPACE_LEARN,
    section: "practice",
    label: "Labs",
    shortLabel: "Labs",
    href: LABS_URL,
    external: true,
    icon: "labs",
    hint: "Practice OSINT challenges",
    brands: [BRAND_ALSYED],
    // "Free" while the labs are open to everyone; "Members" once the
    // `labs_membership_required` switch is on (getWorkspaceItems sets it).
    chip: "Free",
  },
  // Monthly OSINT CTF (WS-MONTHLY-CTF): free for every student, only while `monthly_ctf` is on.
  {
    id: "monthly-ctf",
    workspace: WORKSPACE_LEARN,
    section: "practice",
    label: "Monthly CTF",
    shortLabel: "CTF",
    to: "/monthly-ctf/play",
    icon: "leaderboard",
    hint: "This month's free OSINT case",
    match: [/^\/monthly-ctf\/play\/?$/],
    optional: "monthly_ctf",
  },
  // Engagement (XP, streaks, badges): only while the `engagement` switch is on.
  {
    id: "achievements",
    workspace: WORKSPACE_LEARN,
    section: "progress",
    label: "Achievements",
    shortLabel: "Badges",
    to: "/achievements",
    icon: "achievements",
    hint: "Badges, ranks and certificates",
    match: [/^\/achievements\/?$/],
    optional: "engagement",
  },
  {
    id: "leaderboard",
    workspace: WORKSPACE_LEARN,
    section: "progress",
    label: "Leaderboard",
    shortLabel: "Board",
    to: "/leaderboard",
    icon: "leaderboard",
    hint: "Your batch, this week and all time",
    match: [/^\/leaderboard\/?$/],
    optional: "engagement",
  },
  // Student profiles (WS-PROFILES): the public-page editor, only while `public_profiles` is on.
  {
    id: "public-profile",
    workspace: WORKSPACE_LEARN,
    section: "progress",
    label: "Public profile",
    shortLabel: "Profile",
    to: "/profile/public",
    icon: "publicProfile",
    hint: "Your public page (handle only by default)",
    match: [/^\/profile\/public\/?$/],
    optional: "public_profiles",
  },
  // Attendance and the class calendar (WS-ATTENDANCE): only while the `attendance` switch is on.
  {
    id: "calendar",
    workspace: WORKSPACE_LEARN,
    section: "progress",
    label: "Calendar",
    shortLabel: "Calendar",
    to: "/calendar",
    icon: "calendar",
    hint: "Your live class timetable",
    match: [/^\/calendar\/?$/],
    optional: "attendance",
  },
  {
    id: "attendance",
    workspace: WORKSPACE_LEARN,
    section: "progress",
    label: "Attendance",
    shortLabel: "Attendance",
    to: "/attendance",
    icon: "attendance",
    hint: "Classes attended (40+ minutes live)",
    match: [/^\/attendance\/?$/],
    optional: "attendance",
  },
]);

export const LEARN_SECTIONS = Object.freeze([
  { id: "main", label: "" },
  { id: "practice", label: "Practice" },
  { id: "progress", label: "Progress" },
]);

/** Labs nav chip: "Free" while the labs are open, "Members" once membership is required. */
export const LABS_CHIP_FREE = "Free";
export const LABS_CHIP_MEMBERS = "Members";

// ---------------------------------------------------------------------------
// Teach (non-staff instructors, `teaching` feature). `capability` keys match
// `caps.items` (Appendix A.1). `legacy` patterns keep old URLs highlighted
// until they redirect.
// ---------------------------------------------------------------------------
export const TEACH_ITEMS = Object.freeze([
  {
    id: "teach-today",
    capability: "teach-today",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Today",
    shortLabel: "Today",
    to: TEACH_ROOT,
    icon: "today",
    hint: "What needs you as a teacher",
    match: [/^\/console\/teach\/?$/],
    legacy: [/^\/instructor\/dashboard\/?$/, /^\/control-center\/?$/],
    bottomNav: 1,
  },
  {
    id: "teach-courses",
    capability: "teach-courses",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Courses",
    shortLabel: "Courses",
    to: `${TEACH_ROOT}/courses`,
    icon: "courses",
    hint: "Your courses and curriculum",
    match: [/^\/console\/teach\/courses(?:\/.*)?$/],
    legacy: [/^\/instructor\/courses\/.+$/],
  },
  {
    id: "teach-classes",
    capability: "teach-classes",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Classes",
    shortLabel: "Classes",
    to: `${TEACH_ROOT}/classes`,
    icon: "live",
    hint: "Host and schedule live classes",
    match: [/^\/console\/teach\/classes(?:\/.*)?$/],
    legacy: [/^\/meeting\/?$/, /^\/broadcasting\/?$/],
    bottomNav: 3,
  },
  {
    id: "teach-recordings",
    capability: "teach-recordings",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Recordings",
    shortLabel: "Recordings",
    to: `${TEACH_ROOT}/recordings`,
    icon: "recordings",
    hint: "Upload and publish class recordings",
    match: [/^\/console\/teach\/recordings(?:\/.*)?$/],
    legacy: [/^\/console\/recordings\/upload\/?$/],
    bottomNav: 4,
  },
  {
    id: "teach-grading",
    capability: "teach-grading",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Grading",
    shortLabel: "Grading",
    to: `${TEACH_ROOT}/grading`,
    icon: "grading",
    hint: "Mark weekly reports",
    match: [/^\/console\/teach\/grading(?:\/.*)?$/],
    legacy: [/^\/report-grading(?:\/.*)?$/, /^\/gradebook\/students\/[^/]+\/?$/],
    bottomNav: 2,
  },
  {
    id: "teach-exams",
    capability: "teach-exams",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Exams",
    shortLabel: "Exams",
    to: `${TEACH_ROOT}/exams`,
    icon: "exams",
    hint: "Exams and results",
    match: [/^\/console\/teach\/exams(?:\/.*)?$/],
    legacy: [/^\/console\/exams(?:\/.*)?$/],
    brands: [BRAND_ALSYED],
  },
  // Attendance and the class calendar (WS-ATTENDANCE): only while the `attendance` switch is on.
  {
    id: "teach-attendance",
    capability: "teach-attendance",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Attendance",
    shortLabel: "Attendance",
    to: `${TEACH_ROOT}/attendance`,
    icon: "attendance",
    hint: "Who attended each live class",
    match: [/^\/console\/teach\/attendance\/?$/],
    optional: "attendance",
  },
  {
    id: "teach-calendar",
    capability: "teach-calendar",
    workspace: WORKSPACE_TEACH,
    section: "main",
    label: "Calendar",
    shortLabel: "Calendar",
    to: `${TEACH_ROOT}/calendar`,
    icon: "calendar",
    hint: "Timetables and upcoming classes",
    match: [/^\/console\/teach\/calendar\/?$/],
    optional: "attendance",
  },
]);

export const TEACH_SECTIONS = Object.freeze([{ id: "main", label: "" }]);

// ---------------------------------------------------------------------------
// Admin (staff): the same 8 groups as the Django back office (plan §4.2).
// Wave-2 items open their back-office page (`backOffice`) until the Console
// page is built; they are marked external.
// ---------------------------------------------------------------------------
export const ADMIN_GROUPS = Object.freeze([
  { id: "today", label: "Today", icon: "home" },
  { id: "live", label: "Live classes", icon: "live" },
  { id: "content", label: "Content", icon: "courses" },
  { id: "people", label: "Students & sales", icon: "people" },
  { id: "assessments", label: "Assessments", icon: "exams" },
  { id: "community", label: "Community", icon: "community" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "system", label: "System", icon: "system" },
]);

function backOffice(id, group, label, path, icon, hint) {
  return {
    id,
    workspace: WORKSPACE_ADMIN,
    section: group,
    label,
    shortLabel: label,
    backOffice: path,
    external: true,
    icon,
    hint,
  };
}

export const ADMIN_ITEMS = Object.freeze([
  {
    id: "admin-home",
    workspace: WORKSPACE_ADMIN,
    section: "today",
    label: "Home",
    shortLabel: "Home",
    to: ADMIN_ROOT,
    icon: "home",
    hint: "What needs your attention",
    match: [/^\/console\/admin\/?$/],
    legacy: [/^\/control-center\/?$/],
    bottomNav: 1,
  },
  {
    id: "admin-activity",
    workspace: WORKSPACE_ADMIN,
    section: "today",
    label: "Activity",
    shortLabel: "Activity",
    to: `${ADMIN_ROOT}/activity`,
    icon: "activity",
    hint: "Who changed what",
    match: [/^\/console\/admin\/activity\/?$/],
  },
  {
    id: "admin-classes",
    workspace: WORKSPACE_ADMIN,
    section: "live",
    label: "Classes & studio",
    shortLabel: "Live",
    to: `${ADMIN_ROOT}/classes`,
    icon: "live",
    hint: "Schedule classes and go live",
    match: [/^\/console\/admin\/classes(?!\/chat)(?:\/.*)?$/],
    legacy: [/^\/meeting\/?$/, /^\/broadcasting\/?$/],
    bottomNav: 2,
  },
  backOffice("admin-chat", "live", "Live chat moderation", "realtime/owncastchatidentity/", "community", "Chat names and moderation"),
  // Attendance and the class calendar (WS-ATTENDANCE).
  {
    id: "admin-attendance",
    workspace: WORKSPACE_ADMIN,
    section: "live",
    label: "Attendance",
    shortLabel: "Attendance",
    to: `${ADMIN_ROOT}/attendance`,
    icon: "attendance",
    hint: "Rosters, registers and follow-up",
    match: [/^\/console\/admin\/attendance\/?$/],
  },
  {
    id: "admin-calendar",
    workspace: WORKSPACE_ADMIN,
    section: "live",
    label: "Class calendar",
    shortLabel: "Calendar",
    to: `${ADMIN_ROOT}/calendar`,
    icon: "calendar",
    hint: "Batch timetables and changes",
    match: [/^\/console\/admin\/calendar\/?$/],
  },
  {
    id: "admin-courses",
    workspace: WORKSPACE_ADMIN,
    section: "content",
    label: "Courses",
    shortLabel: "Courses",
    to: `${ADMIN_ROOT}/courses`,
    icon: "courses",
    hint: "Courses and curriculum",
    match: [/^\/console\/admin\/courses(?:\/.*)?$/],
    legacy: [/^\/instructor\/.+$/],
  },
  {
    id: "admin-recordings",
    workspace: WORKSPACE_ADMIN,
    section: "content",
    label: "Recordings",
    shortLabel: "Recordings",
    to: `${ADMIN_ROOT}/recordings`,
    icon: "recordings",
    hint: "Review and publish recordings",
    match: [/^\/console\/admin\/recordings(?!\/upload)(?:\/.*)?$/],
  },
  {
    id: "admin-upload",
    workspace: WORKSPACE_ADMIN,
    section: "content",
    label: "Upload",
    shortLabel: "Upload",
    to: `${ADMIN_ROOT}/recordings/upload`,
    icon: "upload",
    hint: "Upload a class recording",
    match: [/^\/console\/admin\/recordings\/upload\/?$/],
    legacy: [/^\/console\/recordings\/upload\/?$/],
  },
  backOffice("admin-guides", "content", "Guides", "courses/guidevideo/", "guides", "How-to videos for students"),
  {
    id: "admin-requests",
    workspace: WORKSPACE_ADMIN,
    section: "people",
    label: "Requests",
    shortLabel: "Requests",
    to: `${ADMIN_ROOT}/requests`,
    icon: "requests",
    hint: "Approve enrolment requests",
    match: [/^\/console\/admin\/requests\/?$/],
  },
  backOffice("admin-payments", "people", "Payments", "payments/payment/", "payments", "Orders, refunds and access"),
  backOffice("admin-people", "people", "People", "users/user/", "people", "Students, instructors and admins"),
  backOffice("admin-batches", "people", "Batches", "payments/batchpass/", "batches", "Batch passes"),
  backOffice("admin-leads", "people", "Leads & forms", "courses/publicenrollmentlead/", "leads", "Join forms and enquiries"),
  {
    id: "admin-grading",
    workspace: WORKSPACE_ADMIN,
    section: "assessments",
    label: "Grading",
    shortLabel: "Grading",
    to: `${ADMIN_ROOT}/grading`,
    icon: "grading",
    hint: "Mark reports and set weekly tasks",
    match: [/^\/console\/admin\/grading(?:\/.*)?$/],
    legacy: [/^\/report-grading(?:\/.*)?$/, /^\/gradebook\/students\/[^/]+\/?$/],
    bottomNav: 3,
  },
  {
    id: "admin-exams",
    workspace: WORKSPACE_ADMIN,
    section: "assessments",
    label: "Exams",
    shortLabel: "Exams",
    to: `${ADMIN_ROOT}/exams`,
    icon: "exams",
    hint: "Schedule exams and see results",
    match: [/^\/console\/admin\/exams(?:\/.*)?$/],
    legacy: [/^\/console\/exams(?:\/.*)?$/],
    brands: [BRAND_ALSYED],
  },
  {
    id: "admin-questions",
    workspace: WORKSPACE_ADMIN,
    section: "community",
    label: "Questions",
    shortLabel: "Questions",
    to: `${ADMIN_ROOT}/community?tab=questions`,
    icon: "questions",
    hint: "Answer lecture questions",
    match: [/^\/console\/admin\/community\/?$/],
    legacy: [/^\/lecture-questions\/?$/],
  },
  backOffice("admin-comments", "community", "Comments", "courses/lecturecomment/", "community", "Lecture comments"),
  backOffice("admin-reviews", "community", "Reviews", "courses/coursereview/", "reviews", "Course reviews"),
  backOffice("admin-announcements", "community", "Announcements", "notifications/notification/", "announcements", "Messages to students"),
  {
    id: "admin-features",
    workspace: WORKSPACE_ADMIN,
    section: "settings",
    label: "Features",
    shortLabel: "Features",
    to: `${ADMIN_ROOT}/settings/features`,
    icon: "settings",
    hint: "Turn sections on or off",
    match: [/^\/console\/admin\/settings\/features\/?$/],
  },
  backOffice("admin-website", "settings", "Website", "site_media/youtubechannel/", "website", "YouTube channel and website"),
  backOffice("admin-live-config", "settings", "Live config", "realtime/realtimeconfiguration/", "liveConfig", "Streaming configuration"),
  {
    id: "admin-health",
    workspace: WORKSPACE_ADMIN,
    section: "system",
    label: "Health",
    shortLabel: "Health",
    to: `${ADMIN_ROOT}/system/health`,
    icon: "system",
    hint: "Failed jobs and server status",
    match: [/^\/console\/admin\/system\/health\/?$/],
  },
  backOffice("admin-tokens", "system", "Upload tokens", "recording_uploads/recordinguploadtoken/", "tokens", "Desktop uploader tokens"),
  backOffice("admin-back-office", "system", "Back office", "", "backOffice", "Records, settings and audit"),
]);

/** Phone tab bar per workspace: the "Search" tab opens the command palette (staff). */
export const ADMIN_SEARCH_TAB = Object.freeze({
  id: "admin-search",
  workspace: WORKSPACE_ADMIN,
  label: "Search",
  shortLabel: "Search",
  icon: "search",
  action: "palette",
});

/**
 * Pages already rebuilt with Carbon components. Every other shell route is
 * rendered inside the legacy (dark, Tailwind) frame until it is migrated.
 */
export const CARBON_NATIVE_PATHS = [
  // Attendance and the class calendar (WS-ATTENDANCE).
  /^\/attendance\/?$/,
  /^\/calendar\/?$/,
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
  // Phase 3: Console exams and the unified gradebook.
  /^\/console\/exams(\/.*)?$/,
  /^\/gradebook(\/.*)?$/,
  /^\/console\/recordings\/upload\/?$/,
  // UI overhaul (WS-0): Teach and Admin workspaces, Coursework hub.
  /^\/console\/(?:teach|admin)(?:\/.*)?$/,
  /^\/coursework(?:\/.*)?$/,
  // Engagement (WS-LEARN): achievements and the batch leaderboard.
  /^\/achievements\/?$/,
  /^\/leaderboard\/?$/,
  // Monthly OSINT CTF (WS-MONTHLY-CTF): the Console play page.
  /^\/monthly-ctf\/play\/?$/,
  // Old staff URLs: their modules now redirect or render Carbon pages
  // (and "not found" / "switched off" states are Carbon too).
  /^\/(?:meeting|broadcasting|control-center|lecture-questions)\/?$/,
  /^\/instructor\/.+$/,
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

/**
 * Focus mode (template T5): the player, the live room and the host studio.
 * The side nav becomes the icon rail, the phone tab bar hides and the header
 * shows a back arrow.
 */
export const FOCUS_PATHS = [
  /^\/learn\/[^/]+\/?$/,
  /^\/courses\/[^/]+\/live\/?$/,
  /^\/console\/(?:teach|admin)\/classes\/[^/]+\/studio\/?$/,
];

// ---------------------------------------------------------------------------
// Viewer and capability helpers
// ---------------------------------------------------------------------------

function cleanPath(pathname = "") {
  return String(pathname || "").split(/[?#]/)[0];
}

/** Maps the AuthContext flags to the role set (kept for pages that ask "is staff or instructor"). */
export function getUserRoles(auth = {}) {
  const roles = new Set([ROLE_STUDENT]);
  const isInstructor = Boolean(auth?.isInstructor || auth?.user?.role === "instructor");
  const isAdmin = Boolean(auth?.isAdmin || auth?.user?.is_admin);
  if (isInstructor) roles.add(ROLE_INSTRUCTOR);
  if (isAdmin) roles.add(ROLE_ADMIN);
  if (isInstructor || isAdmin) roles.add(ROLE_MODERATOR);
  return roles;
}

/** "staff" | "instructor" | "student" (staff wins: is_admin instructors use Admin). */
export function getViewerKind(auth = {}) {
  if (auth?.isAdmin || auth?.user?.is_admin) return "staff";
  if (auth?.isInstructor || auth?.user?.role === "instructor") return "instructor";
  return "student";
}

export function canSeeNavItem(item, roles, brandId = BRAND_ALSYED) {
  if (item?.brands?.length && !item.brands.includes(brandId)) return false;
  if (!item?.roles || item.roles.length === 0) return true;
  return item.roles.some((role) => roles.has(role));
}

/** External destinations (Labs, back office) open another site in a new tab. */
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

function joinBackOffice(base, path) {
  const root = String(base || BACK_OFFICE).replace(/\/+$/, "");
  return `${root}/${path || ""}`;
}

function brandFilter(brandId) {
  return (item) => !item.brands?.length || item.brands.includes(brandId);
}

/**
 * Teach state for this viewer: { state, reason }. Pure mirror of
 * applyCapabilities (features/capabilities) for the workspace entry, so the
 * nav model stays testable without React.
 */
export function getTeachState(viewerKind, caps) {
  if (viewerKind !== "instructor") return { state: "hidden", reason: "" };
  if (!caps) return { state: "disabled", reason: CHECKING_REASON };
  const entry = caps.workspaces?.teach;
  if (entry?.state === "enabled") return { state: "enabled", reason: "" };
  if (entry?.state === "hidden") return { state: "hidden", reason: "" };
  if (entry?.state === "disabled") return { state: "disabled", reason: entry.reason || TEACHING_OFF_REASON };
  return caps.features?.teaching?.enabled ? { state: "enabled", reason: "" } : { state: "disabled", reason: TEACHING_OFF_REASON };
}

/** Per-item capability (caps.items) for Teach items; falls back to the workspace state. */
function teachItemState(item, workspaceState, caps) {
  const entry = caps?.items?.[item.capability];
  if (entry && ["enabled", "disabled", "hidden"].includes(entry.state)) {
    return { state: entry.state, reason: entry.state === "disabled" ? entry.reason || workspaceState.reason : "" };
  }
  return workspaceState;
}

/**
 * Workspace switch options for this viewer (empty for students: no switch).
 * Each `{ key, label, state, reason, to }`.
 */
export function getWorkspaceOptions(auth = {}, caps = null) {
  const kind = getViewerKind(auth);
  const learn = { ...WORKSPACES.learn, state: "enabled", reason: "", to: WORKSPACES.learn.home };
  if (kind === "staff") {
    return [learn, { ...WORKSPACES.admin, state: "enabled", reason: "", to: WORKSPACES.admin.home }];
  }
  if (kind === "instructor") {
    const teach = getTeachState(kind, caps);
    if (teach.state === "hidden") return [];
    return [learn, { ...WORKSPACES.teach, ...teach, to: WORKSPACES.teach.home }];
  }
  return [];
}

function matchesAny(patterns, path) {
  return Boolean(patterns?.some((pattern) => pattern.test(path)));
}

/** The workspace a path belongs to for this viewer (old URLs count for the workspace that replaces them). */
export function getWorkspaceForPath(pathname = "", auth = {}, caps = null) {
  const path = cleanPath(pathname);
  const kind = getViewerKind(auth);
  if (/^\/console\/admin(?:\/|$)/.test(path)) return kind === "staff" ? WORKSPACE_ADMIN : WORKSPACE_LEARN;
  if (/^\/console\/teach(?:\/|$)/.test(path)) {
    if (kind === "staff") return WORKSPACE_ADMIN;
    return kind === "instructor" && getTeachState(kind, caps).state === "enabled" ? WORKSPACE_TEACH : WORKSPACE_LEARN;
  }
  if (kind === "staff" && ADMIN_ITEMS.some((item) => matchesAny(item.legacy, path))) return WORKSPACE_ADMIN;
  if (kind === "instructor" && getTeachState(kind, caps).state === "enabled" && TEACH_ITEMS.some((item) => matchesAny(item.legacy, path))) {
    return WORKSPACE_TEACH;
  }
  return WORKSPACE_LEARN;
}

/** Internal routes only: an external link is never the current page. */
export function isNavItemActive(item, pathname = "") {
  if (!item || item.external || item.action) return false;
  const path = cleanPath(pathname);
  return matchesAny(item.match, path) || matchesAny(item.legacy, path);
}

export function getActiveNavItemId(items = [], pathname = "") {
  const active = items.find((item) => isNavItemActive(item, pathname));
  return active ? active.id : "";
}

export function isFocusPath(pathname = "") {
  return FOCUS_PATHS.some((pattern) => pattern.test(cleanPath(pathname)));
}

export function isFlushPage(pathname = "") {
  const path = cleanPath(pathname);
  return CARBON_FLUSH_PATHS.some((pattern) => pattern.test(path));
}

export function getShellPageMode(pathname = "") {
  const path = cleanPath(pathname);
  return CARBON_NATIVE_PATHS.some((pattern) => pattern.test(path)) ? "carbon" : "legacy";
}

// ---------------------------------------------------------------------------
// The nav model the shell renders
// ---------------------------------------------------------------------------

function resolveItem(item, { backOfficeUrl }) {
  if (item.backOffice !== undefined) {
    return { ...item, href: joinBackOffice(backOfficeUrl, item.backOffice) };
  }
  return item;
}

/**
 * Items of one workspace for this viewer, each with `state` and `reason`
 * ("enabled" | "disabled" | "hidden"; hidden items are dropped).
 */
export function getWorkspaceItems(workspace, auth = {}, options = {}) {
  const { caps = null, brandId = BRAND_ALSYED, guidesAvailable = true, backOfficeUrl = BACK_OFFICE } = options;
  const kind = getViewerKind(auth);
  const visible = brandFilter(brandId);
  if (workspace === WORKSPACE_ADMIN) {
    if (kind !== "staff") return [];
    return ADMIN_ITEMS.filter(visible).map((item) => ({ ...resolveItem(item, { backOfficeUrl }), state: "enabled", reason: "" }));
  }
  if (workspace === WORKSPACE_TEACH) {
    const teach = getTeachState(kind, caps);
    if (teach.state === "hidden") return [];
    return TEACH_ITEMS.filter(visible)
      .filter((item) => !(item.optional === "attendance" && !caps?.features?.attendance?.enabled))
      .map((item) => ({ ...item, ...teachItemState(item, teach, caps) }))
      .filter((item) => item.state !== "hidden");
  }
  const engagementOn = Boolean(caps?.features?.engagement?.enabled);
  const labsMembersOnly = Boolean(caps?.features?.labs_membership_required?.enabled);
  return LEARN_ITEMS.filter(visible)
    .filter((item) => !(item.optional === "guides" && guidesAvailable === false))
    .filter((item) => !(item.optional === "engagement" && !engagementOn))
    .filter((item) => !(item.optional === "monthly_ctf" && !caps?.features?.monthly_ctf?.enabled))
    .filter((item) => !(item.optional === "public_profiles" && !caps?.features?.public_profiles?.enabled))
    .filter((item) => !(item.optional === "attendance" && !caps?.features?.attendance?.enabled))
    .map((item) => {
      const resolved = { ...item, state: "enabled", reason: "" };
      if (item.id === "labs") resolved.chip = labsMembersOnly ? LABS_CHIP_MEMBERS : LABS_CHIP_FREE;
      return resolved;
    });
}

/** Items grouped for the side nav: `[{ id, label, icon?, items }]` (empty groups dropped). */
export function getWorkspaceSections(workspace, items = []) {
  const sections = workspace === WORKSPACE_ADMIN ? ADMIN_GROUPS : workspace === WORKSPACE_TEACH ? TEACH_SECTIONS : LEARN_SECTIONS;
  return sections
    .map((section) => ({ ...section, items: items.filter((item) => item.section === section.id) }))
    .filter((section) => section.items.length > 0);
}

/** Phone tab bar: up to BOTTOM_NAV_LIMIT primary items (+ "More", rendered by the shell). */
export function getBottomNavItems(items = [], workspace = WORKSPACE_LEARN) {
  const primary = items
    .filter((item) => item.bottomNav && item.state !== "disabled")
    .sort((a, b) => (a.bottomNav === true ? 0 : a.bottomNav) - (b.bottomNav === true ? 0 : b.bottomNav));
  if (workspace === WORKSPACE_ADMIN) {
    return [...primary.slice(0, BOTTOM_NAV_LIMIT - 1), ADMIN_SEARCH_TAB];
  }
  return primary.slice(0, BOTTOM_NAV_LIMIT);
}

/** Everything not in the tab bar goes into the "More" sheet. */
export function getMoreItems(items = [], bottomItems = []) {
  const primaryIds = new Set(bottomItems.map((item) => item.id));
  return items.filter((item) => !primaryIds.has(item.id));
}

/** Avatar menu and More sheet "account" rows. */
export const ACCOUNT_ITEMS = Object.freeze([
  {
    id: "profile",
    label: "Profile",
    to: "/profile",
    icon: "profile",
    match: [/^\/profile\/?$/],
  },
  {
    id: "id-card",
    label: "ID card",
    to: "/id-card",
    icon: "idCard",
    match: [/^\/id-card\/?$/],
  },
]);

/**
 * Everything the shell needs for the current route, in one pure call:
 *
 *   { kind, workspace, workspaces, items, sections, bottomItems, moreItems,
 *     moreSections, activeItem, activeSection, breadcrumbs, isRoot, focus,
 *     backTo, title }
 */
export function buildShellNav(auth = {}, options = {}) {
  const { pathname = "/console", caps = null } = options;
  const path = cleanPath(pathname);
  const kind = getViewerKind(auth);
  const workspaces = getWorkspaceOptions(auth, caps);
  const workspace = getWorkspaceForPath(path, auth, caps);
  const items = getWorkspaceItems(workspace, auth, options);
  const sections = getWorkspaceSections(workspace, items);
  const bottomItems = getBottomNavItems(items, workspace);
  const moreItems = getMoreItems(items, bottomItems);
  const moreSections = getWorkspaceSections(workspace, moreItems);
  const activeItem =
    items.find((item) => item.state === "enabled" && !item.external && matchesAny(item.match, path)) ||
    items.find((item) => item.state === "enabled" && !item.external && matchesAny(item.legacy, path)) ||
    ACCOUNT_ITEMS.find((item) => matchesAny(item.match, path)) ||
    null;
  const activeSection = activeItem ? sections.find((section) => section.id === activeItem.section) || null : null;
  const home = WORKSPACES[workspace];
  const isWorkspaceHome = path.replace(/\/+$/, "") === home.home;
  // A "root" page is one the nav points at directly; deeper pages get a back arrow on phones.
  const isRoot = Boolean(
    isWorkspaceHome ||
      (activeItem && activeItem.to && cleanPath(activeItem.to).replace(/\/+$/, "") === path.replace(/\/+$/, ""))
  );
  const focus = isFocusPath(path);
  const backTo = activeItem && !isRoot ? cleanPath(activeItem.to) : home.home;
  const homeLabel = workspace === WORKSPACE_LEARN ? "Home" : home.label;
  const backLabel = activeItem && !isRoot ? activeItem.label : homeLabel;

  const breadcrumbs = [];
  if (workspace !== WORKSPACE_LEARN) {
    breadcrumbs.push({ label: home.label, to: isWorkspaceHome ? null : home.home });
  }
  if (activeItem && !(isWorkspaceHome && workspace !== WORKSPACE_LEARN) && !(workspace === WORKSPACE_LEARN && activeItem.id === "home")) {
    breadcrumbs.push({ label: activeItem.label, to: isRoot ? null : activeItem.to });
  }

  return {
    kind,
    workspace,
    workspaces,
    items,
    sections,
    bottomItems,
    moreItems,
    moreSections,
    activeItem,
    activeSection,
    breadcrumbs,
    isRoot,
    focus,
    backTo,
    backLabel,
    title: activeItem ? activeItem.label : homeLabel,
  };
}

/**
 * Browser tab title inside the shell: "<page> · Console" (the Learn home is
 * just "Console").
 */
export function getShellDocumentTitle(nav) {
  const item = nav?.activeItem;
  if (!item || item.id === "home") return CONSOLE_TITLE;
  if (item.id === "admin-home") return `Admin · ${CONSOLE_TITLE}`;
  if (item.id === "teach-today") return `Teach · ${CONSOLE_TITLE}`;
  return `${item.label} · ${CONSOLE_TITLE}`;
}

/**
 * Every destination this viewer can open, across their workspaces (the
 * command palette's "Sections" group, plan §4.5). Disabled items are left
 * out; external ones keep `href`.
 */
export function getNavDestinations(auth = {}, options = {}) {
  const workspaces = [WORKSPACE_LEARN, WORKSPACE_TEACH, WORKSPACE_ADMIN];
  const seen = new Set();
  const destinations = [];
  for (const workspace of workspaces) {
    for (const item of getWorkspaceItems(workspace, auth, options)) {
      if (item.state !== "enabled" || seen.has(item.id)) continue;
      seen.add(item.id);
      destinations.push({
        id: item.id,
        label: item.label,
        hint: item.hint || "",
        workspace,
        group: workspace === WORKSPACE_ADMIN ? ADMIN_GROUPS.find((group) => group.id === item.section)?.label || "" : WORKSPACES[workspace].label,
        to: item.to || null,
        href: item.href || null,
        external: Boolean(item.external),
      });
    }
  }
  for (const item of ACCOUNT_ITEMS) {
    destinations.push({ id: item.id, label: item.label, hint: "", workspace: "account", group: "Account", to: item.to, href: null, external: false });
  }
  return destinations;
}

/**
 * Flat list of the Learn and Teach destinations this viewer can open now,
 * plus the account pages (kept for the command palette, WS-G, which adds
 * the admin sitemap itself). Disabled and hidden items are left out.
 * Capabilities come from `options.caps` or `auth.user.capabilities`.
 */
export function getNavItems(auth = {}, options = {}) {
  const caps = options.caps ?? auth?.user?.capabilities ?? null;
  const opts = { ...options, caps };
  return [
    ...getWorkspaceItems(WORKSPACE_LEARN, auth, opts),
    ...getWorkspaceItems(WORKSPACE_TEACH, auth, opts),
    ...ACCOUNT_ITEMS.map((item) => ({ ...item, shortLabel: item.label, hint: "", state: "enabled", reason: "" })),
  ].filter((item) => item.state === "enabled");
}

// ---------------------------------------------------------------------------
// DEPRECATED (WS-C removes the hub's shortcut grid, plan §3.4): the old hub
// tiles. Kept unchanged so the current hub and its tests work until then.
// ---------------------------------------------------------------------------
const LEGACY_TILE_ITEMS = [
  { id: "my-courses", section: "learn", label: "My courses", to: "/my-courses", icon: "courses", hint: "Pick up where you left off" },
  { id: "live-classes", section: "learn", label: "Live classes", to: "/join-live", icon: "live", hint: "Join and schedule classes" },
  { id: "reports", section: "learn", label: "Reports", to: "/reports", icon: "reports", hint: "Weekly targets and your marks" },
  { id: "gradebook", section: "learn", label: "Gradebook", to: "/gradebook", icon: "gradebook", hint: "Report marks and exam results" },
  { id: "guides", section: "learn", label: "Guides", to: "/guides", icon: "guides", hint: "Short how-to videos" },
  { id: "osint-tools", section: "learn", label: "OSINT tools", to: "/osint-tools", icon: "tools", hint: "Your investigation toolkit" },
  { id: "labs", section: "learn", label: "Labs", href: LABS_URL, external: true, icon: "labs", hint: "Practice OSINT challenges", brands: [BRAND_ALSYED] },
  { id: "profile", section: "account", label: "Profile", to: "/profile", icon: "profile", hint: "Name, photo and password" },
  { id: "id-card", section: "account", label: "ID card", to: "/id-card", icon: "idCard", hint: "Your student ID" },
  { id: "instructor-dashboard", section: "teach", label: "Instructor dashboard", to: "/instructor/dashboard", icon: "instructor", hint: "Manage your courses", roles: [ROLE_INSTRUCTOR] },
  { id: "new-course", section: "teach", label: "New course", to: "/instructor/courses/new", icon: "add", hint: "Create and publish a course", roles: [ROLE_INSTRUCTOR] },
  { id: "report-grading", section: "teach", label: "Report grading", to: "/report-grading", icon: "grading", hint: "Set weekly targets and mark reports", roles: [ROLE_MODERATOR] },
  { id: "exams", section: "teach", label: "Exams", to: "/console/exams", icon: "exams", hint: "Schedule CTF exams and see results", roles: [ROLE_MODERATOR], brands: [BRAND_ALSYED] },
  { id: "recording-upload", section: "teach", label: "Upload recording", to: "/console/recordings/upload", icon: "recordingUpload", hint: "Upload the OBS file of a class", roles: [ROLE_MODERATOR] },
  { id: "control-center", section: "teach", label: "Control center", to: "/control-center", icon: "dashboard", hint: "Platform operations", roles: [ROLE_MODERATOR] },
  { id: "meeting", section: "teach", label: "Meeting room", to: "/meeting", icon: "meeting", hint: "Host an interactive class", roles: [ROLE_MODERATOR] },
  { id: "broadcasting", section: "teach", label: "Broadcasting", to: "/broadcasting", icon: "broadcast", hint: "Stream to every student", roles: [ROLE_MODERATOR] },
  { id: "lecture-questions", section: "teach", label: "Lecture questions", to: "/lecture-questions", icon: "questions", hint: "Answer student questions", roles: [ROLE_ADMIN] },
];

/** @deprecated Old hub shortcut tiles (WS-C removes the grid). */
export function getCornerTileGroups(auth = {}, options = {}) {
  const roles = getUserRoles(auth);
  const brandId = options.brandId || BRAND_ALSYED;
  const items = LEGACY_TILE_ITEMS.filter((item) => canSeeNavItem(item, roles, brandId));
  return [
    { id: "corner", label: "Shortcuts", items: items.filter((item) => item.section !== "teach") },
    { id: "teach", label: "Teaching", items: items.filter((item) => item.section === "teach") },
  ].filter((group) => group.items.length > 0);
}
