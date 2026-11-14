// Plan cards for /pricing and the pricing bands. The server's
// `GET /api/catalog/` `plans[]` (HP\contracts\catalog.md §1 PlanPublic) is the
// source of truth; until it answers, these descriptors are shown with NO price
// ("Price at launch") and every paid CTA disabled with a calm reason
// (BUILD_PLAN D9/D10, owner OSINT rules). Nothing here can enable a purchase:
// availability only ever comes from the server.
import { FREE_TIER } from "../data/freeLabs";

export const PRICE_AT_LAUNCH = "Price at launch";
export const PLAN_NOT_OPEN_REASON = "Opens once the price is confirmed. Nothing is charged before then.";
export const PENTESTING_REASON = "Pentesting is coming soon. You can browse every course now; enrolment opens at launch.";
export const MEMBERSHIPS_REASON = "Monthly memberships are not open yet.";

/** OSINT plans, in display order. The CTF Labs membership is the one highlighted plan. */
export const OSINT_PLANS = Object.freeze([
  {
    key: "free",
    group: "osint",
    title: "Free",
    badge: "Start here",
    billing_period: "forever",
    price_inr: 0,
    terms: "No card, no time limit. Follow our path through free public challenges and enter the monthly CTF.",
    note: "No card required",
    state: "available",
    cta_label: "Start free",
    href: FREE_TIER.href,
    features: [
      { text: "Curated directory of free OSINT challenges (we link out)", included: true },
      { text: "Our learning path and self-tracked progress", included: true },
      { text: "Monthly live OSINT CTF (one free case on the 1st)", included: true },
      { text: "Members' labs (easy to professional)", included: false },
      { text: "Recorded classes", included: false },
    ],
  },
  {
    key: "starter",
    group: "osint",
    title: "Starter",
    badge: "Monthly",
    billing_period: "monthly",
    price_inr: null,
    terms: "Your first real cases: the easy and medium labs, plus the class recordings of one batch.",
    state: "coming_soon",
    reason: PLAN_NOT_OPEN_REASON,
    cta_label: "Choose Starter",
    features: [
      { text: "Everything in Free", included: true },
      { text: "Easy and medium challenges in our labs", included: true },
      { text: "Recorded classes of one chosen batch", included: true },
      { text: "Expert and professional labs", included: false },
      { text: "Live classes, reports, exams and certificates", included: false },
    ],
  },
  {
    key: "ctf_labs",
    group: "osint",
    title: "CTF Labs membership",
    badge: "Most complete",
    billing_period: "monthly",
    price_inr: null,
    highlighted: true,
    terms: "Every lab from easy to professional, new cases each month and this month's recorded course bundle. Cancel any time.",
    state: "coming_soon",
    reason: PLAN_NOT_OPEN_REASON,
    cta_label: "Become a member",
    features: [
      { text: "All labs: easy, medium, expert and professional", included: true },
      { text: "New cases every month", included: true },
      { text: "Monthly live CTF with a members' leaderboard", included: true },
      { text: "Hints, then official write-ups and video walkthroughs after a case retires", included: true },
      { text: "OSINT certification exam", included: true },
      { text: "XP, badges and rank", included: true },
      { text: "Members' community and live Q&A", included: true },
      { text: "Toolkits and cheat sheets", included: true },
      { text: "Recorded classes included this month", included: true },
    ],
  },
]);

/** Pentesting plans: browsable, never purchasable while the `pentesting` switch is off. */
export const PENTESTING_PLANS = Object.freeze([
  {
    key: "bootcamp",
    group: "pentesting",
    title: "Bootcamp",
    badge: "One-time",
    billing_period: "once",
    price_inr: null,
    terms: "The four Foundations courses, yours to keep.",
    state: "coming_soon",
    reason: PENTESTING_REASON,
    cta_label: "Start bootcamp",
    features: [
      { text: "Foundations: 4 courses", included: true },
      { text: "Module outlines, exercises and labs", included: true },
      { text: "Lifetime access to these four", included: true },
      { text: "Offensive, defensive and advanced tiers", included: false },
    ],
  },
  {
    key: "pentesting_membership",
    group: "pentesting",
    title: "Pentesting membership",
    badge: "Monthly or yearly",
    billing_period: "monthly",
    price_inr: null,
    terms: "Every Pentesting tier while you are a member. Cancel any time.",
    state: "coming_soon",
    reason: PENTESTING_REASON,
    cta_label: "Become a member",
    periods: { monthly: "pentesting_membership_monthly", yearly: "pentesting_membership_yearly" },
    features: [
      { text: "All five tiers, every course", included: true },
      { text: "New courses as they launch", included: true },
      { text: "Quick wins guides", included: true },
      { text: "Live OSINT cohorts", included: false },
    ],
  },
  {
    key: "lifetime",
    group: "pentesting",
    title: "Lifetime",
    badge: "One-time",
    billing_period: "once",
    price_inr: null,
    terms: "Every Pentesting course in the catalogue, including future ones.",
    state: "coming_soon",
    reason: PENTESTING_REASON,
    cta_label: "Get lifetime access",
    features: [
      { text: "All five tiers, every course", included: true },
      { text: "Future Pentesting courses included", included: true },
      { text: "One payment, no renewals", included: true },
      { text: "Live OSINT cohorts", included: false },
    ],
  },
]);

const PERIOD_LABELS = { monthly: "/ month", yearly: "/ year", once: "one-time", one_time: "one-time", forever: "forever", none: "" };

/** "₹1,649" (whole rupees, Indian grouping). */
export function rupees(amount) {
  const number = Number(amount);
  if (!Number.isFinite(number)) return "";
  const whole = Math.round(number) === number;
  return `₹${number.toLocaleString("en-IN", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "₹0", "₹1,649" or null when the owner has not confirmed a price (never shown before that). */
export function planPriceLabel(plan) {
  if (plan?.key === "free" || plan?.kind === "free") return rupees(0);
  const amount = plan?.price_inr === null || plan?.price_inr === undefined || plan?.price_inr === "" ? NaN : Number(plan.price_inr);
  if (Number.isFinite(amount) && amount === 0) return rupees(0);
  return Number.isFinite(amount) && amount > 0 ? rupees(amount) : null;
}

export function planPeriodLabel(plan) {
  if (plan?.period_label && plan.key !== "free") return plan.period_label.replace(/^\/(\S)/, "/ $1");
  return PERIOD_LABELS[plan?.billing_period] ?? "";
}

/** Server plan keys/products → our descriptor keys. */
export function aliasKey(plan) {
  const product = String(plan?.product || "");
  const key = String(plan?.key || "");
  if (key === "free" || product === "free") return "free";
  if (product === "ctf_starter" || /^(ctf_)?starter/.test(key)) return "starter";
  if (product === "ctf_labs" || key === "ctf_labs_monthly" || key === "labs_membership") return "ctf_labs";
  if (product === "pentesting_bootcamp" || key === "pentesting_bootcamp" || key === "bootcamp") return "bootcamp";
  if (product === "pentesting_lifetime" || key === "pentesting_lifetime" || key === "lifetime") return "lifetime";
  if (product === "pentesting_membership" || /^pentesting_membership/.test(key) || /^membership/.test(key)) return "pentesting_membership";
  return key;
}

/** Contract `price` ("1649.00" | null) → `price_inr` (number | null). */
function serverPrice(server) {
  if ("price" in server) {
    const value = server.price === null || server.price === "" ? null : Number(server.price);
    return Number.isFinite(value) ? value : null;
  }
  if ("price_inr" in server) return server.price_inr;
  return undefined;
}

function normalizeServerPlan(plan) {
  const state = ["available", "coming_soon", "unavailable"].includes(plan.state) ? plan.state : "coming_soon";
  return { ...plan, state, reason: state === "available" ? "" : plan.reason || PLAN_NOT_OPEN_REASON };
}

/**
 * Merges the server's plans over the descriptors (by aliased key). Server
 * fields win; a plan only becomes "available" when the server says so.
 * Server plans of the same group that match no descriptor are appended.
 * `period` picks the monthly or yearly variant of a plan that has both.
 */
export function mergePlans(fallback, serverPlans, { period = "monthly" } = {}) {
  const list = (Array.isArray(serverPlans) ? serverPlans : []).filter((plan) => plan && plan.key);
  const group = fallback[0]?.group;
  const used = new Set();
  const merged = fallback.map((plan) => {
    const candidates = list.filter((server) => aliasKey(server) === plan.key);
    candidates.forEach((server) => used.add(server));
    if (!candidates.length) return plan;
    const server =
      candidates.find((item) => item.billing_period === period) || candidates.find((item) => item.billing_period !== "yearly") || candidates[0];
    const price = serverPrice(server);
    const clean = Object.fromEntries(Object.entries(server).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    return normalizeServerPlan({
      ...plan,
      ...clean,
      key: plan.key,
      server_key: server.key,
      title: plan.key === "free" ? plan.title : server.title || plan.title,
      price_inr: price === undefined ? plan.price_inr : price,
      href: server.href || plan.href,
      features: Array.isArray(server.features) && server.features.length ? server.features : plan.features,
      variants: candidates.length > 1 ? candidates.map((item) => ({ key: item.key, billing_period: item.billing_period, price_inr: serverPrice(item) })) : plan.variants,
    });
  });
  const extra = list
    .filter((plan) => !used.has(plan) && (!group || (plan.group || plan.family) === group))
    .map((plan) => normalizeServerPlan({ ...plan, price_inr: serverPrice(plan) ?? null }));
  return [...merged, ...extra];
}

/** Where an available plan's CTA goes: the free path, or the plan checkout (auth WS route). */
export function planHref(plan) {
  if (plan?.key === "free") return plan.href || FREE_TIER.href;
  if (plan?.href) return plan.href;
  return `/pricing?plan=${encodeURIComponent(plan?.server_key || plan?.key || "")}#checkout`;
}
