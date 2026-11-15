// Pure model for the website navbar (no React): which links show in the
// centred pill, which go under "More", and what the account menu and the
// phone sheet contain. Kept separate so it can be unit tested per brand.
//
// Restored to the production navbar of 7a444898 (owner, Nov 2026: "the same
// as before with all its functionalities"). Pentesting, Roadmap, Labs and
// Pricing stay reachable from Courses, the footer and the landing page.

export const SITE_CONSOLE_PATH = "/console";
/** The OSINT labs (CTF) site: external, Al Syed brand only (footer, free labs). */
export const LABS_URL = "https://labs.alsyedinitiative.com";

const LINKS = {
  courses: { id: "courses", label: "Courses", to: "/courses" },
  watch: { id: "watch", label: "Watch", to: "/watch", needsYouTube: true },
  about: { id: "about", label: "About Us", shortLabel: "About", to: "/about" },
  accounts: { id: "accounts", label: "AS-Accounts", to: "/as-accounts", brandOnly: "alsyed" },
  nationalDesk: { id: "national-desk", label: "National Desk", to: "/national-desk", brandOnly: "alsyed" },
  join: { id: "join", label: "Join Al Syed", to: "/join-alsyed", brandOnly: "alsyed" },
  hallOfFame: { id: "hall-of-fame", label: "Hall of Fame", to: "/hall-of-fame", brandOnly: "alsyed" },
  contact: { id: "contact", label: "Contact", to: "/contact" },
  faqs: { id: "faqs", label: "FAQs", to: "/faqs" },
  cases: { id: "cases", label: "Cases", href: "https://cases.alsyedinitiative.com", external: true, brandOnly: "alsyed" },
};

/** Centred pill (desktop), in order. "Watch" (YouTube) only where the brand has the channel. */
const PRIMARY = ["courses", "watch", "about", "nationalDesk", "contact"];
/** "More" menu (desktop), in order. */
const MORE = ["accounts", "join", "hallOfFame", "cases", "faqs"];

const visibleFor = (brandId, { youtube = false } = {}) => (link) =>
  (!link.brandOnly || link.brandOnly === brandId) && (!link.needsYouTube || youtube);

/**
 * Desktop navigation: the key links in the pill, the rest under "More".
 * OwlCognito has no Al Syed programmes, so its links need no "More".
 * `youtube` adds "Watch" (the YouTube channel) right after Courses.
 */
export function getSiteNavLinks(brandId = "alsyed", options = {}) {
  const visible = visibleFor(brandId, options);
  const primary = PRIMARY.map((key) => LINKS[key]).filter(visible);
  const more = MORE.map((key) => LINKS[key]).filter(visible);
  if (primary.length + more.length <= 5 + (options.youtube ? 1 : 0)) {
    return { primary: [...primary, ...more], more: [] };
  }
  return { primary, more };
}

/** Phone sheet groups: every website link, grouped. */
export function getSiteNavGroups(brandId = "alsyed", options = {}) {
  const visible = visibleFor(brandId, options);
  const pick = (keys) => keys.map((key) => LINKS[key]).filter(visible);
  return [
    { id: "explore", label: "Explore", links: pick(["courses", "watch", "about", "contact", "faqs"]) },
    { id: "community", label: "Al Syed", links: pick(["nationalDesk", "accounts", "join", "hallOfFame", "cases"]) },
  ].filter((group) => group.links.length > 0);
}

/**
 * Watch (the YouTube channel) in the header, sheet and footer (plan §7.2 rule 4):
 * - "hidden" when the brand has no channel or the server switched the section off;
 * - "disabled" ("No videos yet") when it is on but has nothing to play;
 * - "live" while the channel is on air (the only time the live dot shows);
 * - "ready" otherwise (also while the first answer is loading).
 */
export const WATCH_EMPTY_REASON = "No videos yet";

export function getWatchNavState({ brandHasYouTube = false, youtube = null } = {}) {
  if (!brandHasYouTube || youtube?.enabled === false) return "hidden";
  if (youtube?.status === "ready" && !youtube?.model) return "disabled";
  if (youtube?.model?.live) return "live";
  return "ready";
}

/** True when the current path belongs to one of the links (prefix match like NavLink). */
export function isSiteLinkActive(link, pathname = "") {
  if (!link?.to) return false;
  const path = String(pathname || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return path === link.to || path.startsWith(`${link.to}/`);
}

/**
 * Account menu (avatar dropdown / phone sheet) for a signed-in user,
 * gated exactly like the previous navbar: instructors get the instructor
 * dashboard, instructors and admins the staff controls, admins lecture
 * questions and the Django admin.
 */
export function getAccountMenuGroups({ isInstructor = false, isAdmin = false, djangoAdminUrl = "" } = {}) {
  const canAccessControls = Boolean(isAdmin || isInstructor);
  const staff = [
    isInstructor ? { id: "instructor", label: "Instructor", to: "/instructor/dashboard" } : null,
    isAdmin ? { id: "control-center", label: "Admin Control Center", to: "/control-center" } : null,
    canAccessControls ? { id: "meeting", label: "Meeting Control", to: "/meeting" } : null,
    canAccessControls ? { id: "broadcasting", label: "Broadcast Control", to: "/broadcasting" } : null,
    isAdmin ? { id: "lecture-questions", label: "Lecture Questions", to: "/lecture-questions" } : null,
    isAdmin && djangoAdminUrl ? { id: "django-admin", label: "Django Admin", href: djangoAdminUrl, external: true } : null,
  ].filter(Boolean);
  return [
    {
      id: "account",
      label: "Your account",
      links: [
        { id: "console", label: "Console", to: SITE_CONSOLE_PATH },
        { id: "my-courses", label: "My courses", to: "/my-courses" },
        { id: "guides", label: "Guides", to: "/guides" },
        { id: "profile", label: "Profile", to: "/profile" },
        { id: "id-card", label: "ID Card", to: "/id-card" },
      ],
    },
    { id: "staff", label: "Staff tools", links: staff },
  ].filter((group) => group.links.length > 0);
}

/** "AR" from "Asha Rao", else the first letter of the e-mail, else "?". */
export function getInitials(user) {
  const name = String(user?.full_name || "").trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 1);
    return letters.toUpperCase();
  }
  const email = String(user?.email || "").trim();
  return email ? email[0].toUpperCase() : "?";
}

/** "Asha" for the compact avatar button. */
export function getShortName(user) {
  const name = String(user?.full_name || "").trim();
  if (name) return name.split(/\s+/)[0];
  return String(user?.email || "").split("@")[0] || "Account";
}
