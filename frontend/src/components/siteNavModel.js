// Pure model for the website navbar (no React): which links show in the
// centred pill, which go under "More", and what the account menu and the
// phone sheet contain. Kept separate so it can be unit tested per brand.

export const SITE_CONSOLE_PATH = "/console";

const LINKS = {
  courses: { id: "courses", label: "Courses", to: "/courses" },
  about: { id: "about", label: "About Us", shortLabel: "About", to: "/about" },
  accounts: { id: "accounts", label: "AS-Accounts", to: "/as-accounts", brandOnly: "alsyed" },
  nationalDesk: { id: "national-desk", label: "National Desk", to: "/national-desk", brandOnly: "alsyed" },
  join: { id: "join", label: "Join Al Syed", to: "/join-alsyed", brandOnly: "alsyed" },
  hallOfFame: { id: "hall-of-fame", label: "Hall of Fame", to: "/hall-of-fame", brandOnly: "alsyed" },
  contact: { id: "contact", label: "Contact", to: "/contact" },
  faqs: { id: "faqs", label: "FAQs", to: "/faqs" },
};

/** Centred pill (desktop), in order. */
const PRIMARY = ["courses", "about", "nationalDesk", "contact"];
/** "More" menu (desktop), in order. */
const MORE = ["accounts", "join", "hallOfFame", "faqs"];

const visibleFor = (brandId) => (link) => !link.brandOnly || link.brandOnly === brandId;

/**
 * Desktop navigation: up to four primary links, the rest under "More".
 * OwlCognito has no Al Syed programmes, so its four links need no "More".
 */
export function getSiteNavLinks(brandId = "alsyed") {
  const visible = visibleFor(brandId);
  const primary = PRIMARY.map((key) => LINKS[key]).filter(visible);
  const more = MORE.map((key) => LINKS[key]).filter(visible);
  if (primary.length + more.length <= 5) {
    return { primary: [...primary, ...more], more: [] };
  }
  return { primary, more };
}

/** Phone sheet groups: every website link, grouped. */
export function getSiteNavGroups(brandId = "alsyed") {
  const visible = visibleFor(brandId);
  return [
    { id: "explore", label: "Explore", links: ["courses", "about", "contact", "faqs"].map((key) => LINKS[key]) },
    {
      id: "community",
      label: "Al Syed",
      links: ["nationalDesk", "accounts", "join", "hallOfFame"].map((key) => LINKS[key]).filter(visible),
    },
  ].filter((group) => group.links.length > 0);
}

/** True when the current path belongs to one of the links (prefix match like NavLink). */
export function isSiteLinkActive(link, pathname = "") {
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
    canAccessControls ? { id: "control-center", label: "Admin Control Center", to: "/control-center" } : null,
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
