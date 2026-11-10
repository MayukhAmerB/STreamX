// Admin-configured payment plan cards (course detail `payment_plans`).
//
// The backend sends the enabled cards, already ordered, with display copy the
// admin wrote. Everything here is defensive: amounts arrive as decimal
// strings, optional copy may be null, and an older backend may not send the
// field at all (then the caller falls back to the legacy price fields).
// Pure functions only (no React, no DOM) so they are easy to unit test.

/** Plan identifiers the checkout API accepts (sent back unchanged as `plan`). */
export const CHECKOUT_PLAN_IDS = ["monthly", "full", "batch_pass", "bundle"];

export const MIN_CARDS_PER_ROW = 2;
export const MAX_CARDS_PER_ROW = 4;

const DEFAULT_TITLES = {
  monthly: "Monthly",
  full: "One-time",
  batch_pass: "All future batches",
  bundle: "Bundle",
};

const DEFAULT_UNAVAILABLE_REASON = "This plan is not available right now.";

function cleanText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function positiveAmount(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Formats an amount in `currency` (falls back to INR, then to plain digits). */
export function formatPlanAmount(amount, currency = "INR") {
  const code = /^[A-Za-z]{3}$/.test(String(currency || "")) ? String(currency).toUpperCase() : "INR";
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : undefined, {
      style: "currency",
      currency: code,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return String(amount);
  }
}

/**
 * Splits "₹1,500 / month" into { amount: "₹1,500", suffix: "/ month" } so
 * the figure can be set large and the interval small. Labels without a
 * leading figure ("Free", "Pricing on request") stay whole.
 */
export function splitPriceLabel(label) {
  const text = cleanText(label);
  const match = /^(\D{0,8}?\d[\d,]*(?:\.\d+)?)(?:\s*)(.*)$/u.exec(text);
  if (!match) return { amount: text, suffix: "" };
  return { amount: match[1].trim(), suffix: match[2].trim() };
}

/** True when the backend sent the admin-configured cards (even an empty list). */
export function hasConfiguredPaymentPlans(course) {
  return Array.isArray(course?.payment_plans);
}

/** One raw `payment_plans` entry -> a display/checkout model, or null if unusable. */
export function normalizePaymentPlan(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.plan);
  if (!CHECKOUT_PLAN_IDS.includes(id)) return null;

  const currency = cleanText(raw.currency).toUpperCase() || "INR";
  const amount = positiveAmount(raw.amount);
  const priceLabel = cleanText(raw.price_label) || (amount ? formatPlanAmount(amount, currency) : "");
  const hasPrice = amount > 0;
  const available = raw.available !== false && hasPrice;
  const unavailableReason = available
    ? ""
    : cleanText(raw.unavailable_reason) || (hasPrice ? DEFAULT_UNAVAILABLE_REASON : "Pricing will be announced soon.");
  const order = Number(raw.order);

  return {
    id,
    title: cleanText(raw.title) || DEFAULT_TITLES[id],
    subtitle: cleanText(raw.subtitle),
    amount,
    currency,
    priceLabel: priceLabel || "To be announced",
    totalLabel: cleanText(raw.total_label),
    installments: positiveInteger(raw.installments),
    accessLabel: cleanText(raw.access_label),
    features: Array.isArray(raw.features)
      ? raw.features.map(cleanText).filter(Boolean).slice(0, 10)
      : [],
    badge: cleanText(raw.badge),
    highlighted: raw.highlighted === true,
    ctaLabel: cleanText(raw.cta_label) || "Enroll now",
    order: Number.isFinite(order) ? order : index,
    position: index,
    available,
    unavailableReason,
  };
}

/** Every configured card (available or not), deduplicated and in admin order. */
export function configuredPaymentPlanCards(course) {
  if (!hasConfiguredPaymentPlans(course)) return [];
  const seen = new Set();
  return course.payment_plans
    .map((raw, index) => normalizePaymentPlan(raw, index))
    .filter((plan) => {
      if (!plan || seen.has(plan.id)) return false;
      seen.add(plan.id);
      return true;
    })
    .sort((a, b) => a.order - b.order || a.position - b.position)
    .map((plan, index) => ({ ...plan, number: index + 1 }));
}

/**
 * Desktop column count: the admin's `payment_cards_per_row` (2-4), else the
 * card count clamped to 2-4; never more columns than there are cards.
 */
export function paymentCardColumns(course, cardCount) {
  const requested = Number(course?.payment_cards_per_row);
  const count = Math.max(0, Number(cardCount) || 0);
  const perRow = Number.isInteger(requested) && requested >= MIN_CARDS_PER_ROW && requested <= MAX_CARDS_PER_ROW
    ? requested
    : Math.min(MAX_CARDS_PER_ROW, Math.max(MIN_CARDS_PER_ROW, count));
  return Math.max(1, Math.min(perRow, count || perRow));
}

/**
 * Headline fee for course detail pages from the admin cards: the highlighted
 * plan, else the one-time plan, else the first available. "" when the backend
 * did not send `payment_plans` or nothing is purchasable (callers fall back).
 */
export function configuredCourseFeeLabel(course) {
  const available = configuredPaymentPlanCards(course).filter((plan) => plan.available);
  const plan = available.find((item) => item.highlighted)
    || available.find((item) => item.id === "full")
    || available[0];
  return plan ? plan.priceLabel : "";
}
