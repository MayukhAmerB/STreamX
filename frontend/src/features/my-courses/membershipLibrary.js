// "Included this month": recordings an OSINT plan unlocks without an
// enrollment (contract hackpath/contracts/catalog.md §1 PlanPublic,
// §4 entitlement, §5 subscriptions). OWNER: WS-LEARN. Pure, no React.
//
// CTF Labs membership -> this IST month's bundle + always-included courses
// (`included_this_month` of the `ctf_labs` plan). Starter -> the recordings of
// the one batch linked to the viewer's Starter plan (`starter_course`).
// Words only: the server decides every playback.

export const SOURCE_BUNDLE = "membership_bundle";
export const SOURCE_STARTER = "starter";

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-11" -> "November 2026" ("" when unreadable). */
export function formatBundleMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return Number.isNaN(date.getTime()) ? "" : monthFormat.format(date);
}

function isLiveSubscription(sub, now) {
  if (!sub) return false;
  const until = sub.access_until ? new Date(sub.access_until).getTime() : NaN;
  if (!Number.isNaN(until)) return until > now;
  return sub.status === "active" || sub.status === "authenticated";
}

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * `{ active, labsActive, starterActive, monthLabel, courses: [{id, title, source, label}] }`.
 * Courses the viewer is already enrolled in (`ownedIds`) are left out: they
 * are in the main grid already.
 */
export function buildMembershipLibrary({ entitlement = null, subscriptions = null, catalog = null, ownedIds = [], now = Date.now() } = {}) {
  const plans = list(catalog?.plans);
  const subs = list(subscriptions?.subscriptions).filter((sub) => isLiveSubscription(sub, now));
  const grants = (key) => subs.some((sub) => list(sub.entitlements).includes(key));
  const labsActive = Boolean(entitlement?.ctf_labs?.active) || grants("ctf_labs");
  const starterActive = Boolean(entitlement?.ctf_starter?.active) || grants("ctf_starter");
  const owned = new Set(list(ownedIds).map(String));
  const seen = new Set();
  const courses = [];
  const add = (course, source) => {
    if (!course || course.id == null) return;
    const key = String(course.id);
    if (owned.has(key) || seen.has(key)) return;
    seen.add(key);
    courses.push({
      id: course.id,
      title: course.title || "Untitled course",
      source,
      label: source === SOURCE_BUNDLE ? "Included this month" : "Included with Starter",
    });
  };

  let monthLabel = "";
  if (labsActive) {
    const labsPlan = plans.find((plan) => plan?.product === "ctf_labs" && plan?.included_this_month);
    monthLabel = formatBundleMonth(labsPlan?.included_this_month?.month);
    list(labsPlan?.included_this_month?.courses).forEach((course) => add(course, SOURCE_BUNDLE));
  }
  if (starterActive) {
    // Only the viewer's own Starter plans (a comp grant without a subscription
    // cannot be told apart here; its course page and player still work).
    const starterKeys = new Set(subs.filter((sub) => list(sub.entitlements).includes("ctf_starter")).map((sub) => sub.plan_key));
    plans
      .filter((plan) => plan?.product === "ctf_starter" && plan?.starter_course && starterKeys.has(plan.key))
      .forEach((plan) => add(plan.starter_course, SOURCE_STARTER));
  }
  return { active: labsActive || starterActive, labsActive, starterActive, monthLabel, courses };
}
