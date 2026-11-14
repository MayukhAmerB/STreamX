// Pure model for the website navbar (no React): which links show in the
// centred pill, which go under "More", and what the account menu and the
// phone sheet contain. Kept separate so it can be unit tested per brand.
// Direct file imports (not the capabilities index): the public bundle must
// not pull in the Console's Carbon components.
import applyCapabilities, { resolveCapability } from "../features/capabilities/applyCapabilities";

export const SITE_CONSOLE_PATH = "/console";
/** The OSINT labs (CTF) site: external, Al Syed brand only (plan §7.3 additions). */
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
  labs: { id: "labs", label: "Labs", href: LABS_URL, external: true, brandOnly: "alsyed" },
  // HackPath-philosophy nav (BUILD_PLAN §1.4): the Pentesting track is browsable
  // while purchases are switched off, so it carries a calm "Soon" chip.
  pentesting: { id: "pentesting", label: "Pentesting", to: "/tracks/pentesting", chip: "Soon", brandOnly: "alsyed" },
  roadmap: { id: "roadmap", label: "Roadmap", to: "/roadmap", brandOnly: "alsyed" },
  pricing: { id: "pricing", label: "Pricing", to: "/pricing", brandOnly: "alsyed" },
};

/**
 * Centred links (desktop), in order. OwlCognito has no Al Syed programmes,
 * plans or labs: its brand filter leaves Courses, About, Contact and FAQs.
 */
const PRIMARY = ["courses", "pentesting", "roadmap", "labs", "pricing"];
/** "More" menu (desktop), in order: every other website link ("Watch" only where the brand has the channel). */
const MORE = ["watch", "about", "nationalDesk", "accounts", "join", "hallOfFame", "contact", "faqs"];

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
  const learn = pick(["courses", "pentesting", "roadmap", "pricing", "labs"]);
  // A brand with only "Courses" to learn from keeps one Explore group.
  const learnGroup = learn.length > 1 ? learn : [];
  return [
    { id: "learn", label: "Learn", links: learnGroup },
    { id: "explore", label: "Explore", links: [...(learnGroup.length ? [] : learn), ...pick(["watch", "about", "contact", "faqs"])] },
    { id: "community", label: "Al Syed", links: pick(["nationalDesk", "accounts", "join", "hallOfFame"]) },
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

/** Staff land here (plan D3); "Admin" in the account menu opens it. */
export const SITE_ADMIN_PATH = "/console/admin";

/**
 * Teaching shortcuts for instructors. Their state comes from the server's
 * capabilities (`caps.items`), never from a role check here (plan §6.7).
 */
export const TEACH_MENU_LINKS = Object.freeze([
  { id: "teach-today", label: "Teach", to: "/console/teach", capability: "teach-today" },
  { id: "teach-classes", label: "Classes", to: "/console/teach/classes", capability: "teach-classes" },
  { id: "teach-grading", label: "Grading", to: "/console/teach/grading", capability: "teach-grading" },
]);

/**
 * Account menu (avatar dropdown / phone sheet) for a signed-in user. Every
 * gated row comes from the capabilities contract (Appendix A.1), so the site
 * and the Console can never disagree about who sees what:
 * - Teaching (instructors): the shortcuts when the Teach workspace is on, one
 *   disabled "Teach" row with the server's reason when it is switched off,
 *   nothing when it is hidden (students, staff);
 * - Admin (staff): the Console Admin home and the back office (Django admin).
 * Until the capabilities arrive (`caps` null) only the ungated rows show, so
 * nothing flashes in and out.
 */
export function getAccountMenuGroups({ caps = null, djangoAdminUrl = "" } = {}) {
  const groups = [
    {
      id: "account",
      label: "Your account",
      links: [
        { id: "console", label: "Open Console", to: SITE_CONSOLE_PATH },
        { id: "my-courses", label: "My courses", to: "/my-courses" },
        { id: "profile", label: "Profile", to: "/profile" },
        { id: "id-card", label: "ID card", to: "/id-card" },
      ],
    },
  ];
  if (!caps) return groups;

  const teach = resolveCapability({ workspace: "teach" }, caps);
  if (teach.state === "enabled") {
    const links = applyCapabilities(TEACH_MENU_LINKS, caps).filter((link) => link.state !== "hidden");
    if (links.length) groups.push({ id: "teaching", label: "Teaching", links });
  } else if (teach.state === "disabled") {
    groups.push({
      id: "teaching",
      label: "Teaching",
      links: [{ id: "teach", label: "Teach", to: "/console/teach", state: "disabled", reason: teach.reason }],
    });
  }

  if (resolveCapability({ workspace: "admin" }, caps).state === "enabled") {
    groups.push({
      id: "admin",
      label: "Admin",
      links: [
        { id: "admin", label: "Admin", to: SITE_ADMIN_PATH },
        djangoAdminUrl ? { id: "back-office", label: "Back office", href: djangoAdminUrl, external: true } : null,
      ].filter(Boolean),
    });
  }
  return groups;
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
