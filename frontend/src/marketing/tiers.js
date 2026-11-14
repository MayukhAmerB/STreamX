// Catalogue grouping (BUILD_PLAN §3): OSINT first, then the Pentesting tiers
// in order. Course data always comes from the API; this file only holds the
// tier labels/summaries (our words) and the grouping rules.
import { getCourseLaunchStatus } from "../utils/courseStatus";

export const PENTESTING_TIERS = Object.freeze([
  { key: "foundations", label: "Foundations", summary: "The groundwork every security role stands on." },
  { key: "offensive", label: "Offensive security", summary: "Find, prove and report weaknesses inside an agreed scope." },
  { key: "defensive", label: "Defensive security", summary: "Detect, investigate and contain attacks on real systems." },
  { key: "advanced", label: "Advanced operations", summary: "Enterprise attack paths, privilege and persistence, for experienced learners." },
  { key: "quick_wins", label: "Quick wins", summary: "One problem, one sitting: practical guides for everyday security." },
]);

export const TRACKS = Object.freeze({
  osint: {
    key: "osint",
    slug: "osint",
    category: "osint",
    title: "Open Source Intelligence",
    short: "OSINT",
    summary: "Find, verify and report what is public: people, infrastructure and events, with a method you can defend.",
    art: "magnifier",
  },
  pentesting: {
    key: "web_pentesting",
    slug: "pentesting",
    category: "web_pentesting",
    title: "Pentesting",
    short: "Pentesting",
    summary: "From first principles to enterprise attack paths: five tiers, every module outline open to browse.",
    art: "foundations",
  },
});

/** "/tracks/osint" | "/tracks/pentesting" from a category key. */
export function trackPath(category) {
  return category === "web_pentesting" || category === "pentesting" ? "/tracks/pentesting" : "/tracks/osint";
}

export function trackForSlug(slug) {
  const text = String(slug || "").toLowerCase();
  if (text === "pentesting" || text === "web_pentesting" || text === "web-pentesting") return TRACKS.pentesting;
  if (text === "osint") return TRACKS.osint;
  return null;
}

const LEVEL_LABELS = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };

export function levelLabel(level) {
  const key = String(level || "").toLowerCase();
  return LEVEL_LABELS[key] || (key ? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ") : "All levels");
}

export function tierOf(course) {
  const key = String(course?.tier || "").trim().toLowerCase();
  return PENTESTING_TIERS.some((tier) => tier.key === key) ? key : "";
}

/** Number of modules a course shows: its public outline, else its published sections. */
export function moduleCount(course) {
  const fromField = Number(course?.module_count);
  if (Number.isFinite(fromField) && fromField > 0) return Math.trunc(fromField);
  if (Array.isArray(course?.public_curriculum) && course.public_curriculum.length) return course.public_curriculum.length;
  const sections = Number(course?.section_count);
  return Number.isFinite(sections) && sections > 0 ? Math.trunc(sections) : 0;
}

/** "~10h" style duration label from the course fields, or "". */
export function hoursLabel(course) {
  const label = String(course?.total_hours_label || "").trim();
  if (label) return label.replace(/\bhours?\b/i, "h").replace(/\s+h$/, "h");
  const hours = Number(course?.total_hours);
  return Number.isFinite(hours) && hours > 0 ? `${hours}h` : "";
}

/** Card status: Open / Coming soon / Previous batch (icon + word, never hue). */
export function courseStatus(course) {
  if (course?.registration_closed && getCourseLaunchStatus(course).isLive) return { kind: "closed", label: "Previous batch" };
  if (getCourseLaunchStatus(course).isComingSoon || course?.registration_closed) return { kind: "soon", label: "Coming soon" };
  return { kind: "open", label: "Open" };
}

const byTierOrder = (a, b) =>
  (Number(a?.tier_order) || 0) - (Number(b?.tier_order) || 0) ||
  (Number(a?.id) || 0) - (Number(b?.id) || 0);

/**
 * Pentesting courses grouped into the five tiers (in order); courses without
 * a tier fall into a trailing "More Pentesting courses" group so nothing
 * published is ever hidden.
 */
export function groupPentestingTiers(courses) {
  const pentesting = (Array.isArray(courses) ? courses : []).filter((course) => course?.category === "web_pentesting");
  const groups = PENTESTING_TIERS.map((tier) => ({ ...tier, courses: pentesting.filter((course) => tierOf(course) === tier.key).sort(byTierOrder) }));
  const untiered = pentesting.filter((course) => !tierOf(course)).sort(byTierOrder);
  if (untiered.length) {
    groups.push({ key: "more", label: "More Pentesting courses", summary: "Courses that are not in a tier yet.", courses: untiered });
  }
  return groups.filter((group) => group.courses.length > 0);
}

export function osintCourses(courses) {
  return (Array.isArray(courses) ? courses : []).filter((course) => course?.category === "osint");
}
