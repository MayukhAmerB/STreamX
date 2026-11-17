// Platform-plan checkout (CTF Labs membership, Starter, Bootcamp, Lifetime…).
//
// Contract: hackpath/contracts/catalog.md §5 (WS-CATALOG owns the endpoints):
//   POST /api/payment/subscriptions/            {plan_key} -> {subscription_id, key_id, name, description, prefill}
//   POST /api/payment/subscriptions/verify/     {razorpay_payment_id, razorpay_subscription_id, razorpay_signature}
//   POST /api/payment/platform/orders/          {plan_key} -> {order_id, key_id, amount_paise, currency, name, description}
//   POST /api/payment/platform/orders/verify/   {razorpay_order_id, razorpay_payment_id, razorpay_signature}
// Refusals: 403 feature_disabled | plan_unavailable, 409 already_subscribed | already_owned.
//
// Built but unreachable while the plans are disabled: `platformPlanGate` keeps
// the action disabled (with the reason) unless the catalogue says the plan is
// "available" with a confirmed price, and the server refuses anyway.
// Every dependency is injectable so the flow is unit-tested without Razorpay.

import apiClient, { featureDisabledDetail } from "../../api/client";
import { apiData } from "../../utils/api";
import { isPaymentGatewayUnavailable, isTransientPaymentError, withPaymentRetries } from "../../utils/paymentRetry";

export const PAYMENT_PENDING_MESSAGE =
  "Payment received. We could not confirm it yet; your access will appear in the Console within a few minutes. Do not pay again.";
export const PAYMENTS_PAUSED_MESSAGE =
  "Payments are temporarily unavailable. Please try again in a minute; you have not been charged.";

export const RAZORPAY_CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
export const PRICE_AT_LAUNCH_REASON = "The price is confirmed at launch. This plan opens then.";
export const PLAN_UNAVAILABLE_REASON = "This plan is not open yet.";

const SUBSCRIPTION_PERIODS = new Set(["month", "monthly", "year", "yearly"]);

function text(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** A recurring plan is paid with a Razorpay subscription; anything else with a one-time order. */
export function isSubscriptionPlan(plan) {
  if (!plan) return false;
  if (plan.kind === "subscription") return true;
  if (plan.kind === "one_time" || plan.kind === "lifetime") return false;
  return SUBSCRIPTION_PERIODS.has(String(plan.billing_period || "").toLowerCase());
}

/**
 * { blocked, reason, code } for buying `plan`. Disable, never hide: the
 * caller renders the button with `reason` next to it.
 *  - the plan's own state (available | coming_soon | unavailable) and reason
 *  - a switch that is off in `gates` (memberships for subscriptions,
 *    pentesting for the Pentesting family)
 *  - an unconfirmed price (`price_inr` null): "Price at launch"
 */
export function platformPlanGate(plan, { gates = null } = {}) {
  if (!plan || !plan.key) return { blocked: true, reason: PLAN_UNAVAILABLE_REASON, code: "plan_unavailable" };
  if (plan.key === "free") return { blocked: false, reason: "", code: "" };
  if (plan.state && plan.state !== "available") {
    return { blocked: true, reason: text(plan.reason) || PLAN_UNAVAILABLE_REASON, code: plan.code || plan.state };
  }
  if (isSubscriptionPlan(plan) && gates?.memberships && gates.memberships.enabled === false) {
    return { blocked: true, reason: text(gates.memberships.reason) || PLAN_UNAVAILABLE_REASON, code: "feature_disabled" };
  }
  if (plan.family === "pentesting" && gates?.pentesting && gates.pentesting.enabled === false) {
    return { blocked: true, reason: text(gates.pentesting.reason) || PLAN_UNAVAILABLE_REASON, code: "feature_disabled" };
  }
  if (plan.price_inr === null || plan.price_inr === undefined || plan.price_inr === "") {
    return { blocked: true, reason: PRICE_AT_LAUNCH_REASON, code: "price_unconfirmed" };
  }
  return { blocked: false, reason: "", code: "" };
}

export function createPlanIdempotencyKey() {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `plan-${random}`;
}

/** Load Razorpay Checkout once (same script and limits as the course checkout). */
export function loadRazorpayCheckout({ doc = typeof document !== "undefined" ? document : null, win = typeof window !== "undefined" ? window : null, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (win?.Razorpay) {
      resolve(win.Razorpay);
      return;
    }
    if (!doc || !win) {
      reject(new Error("Razorpay checkout is unavailable."));
      return;
    }
    const timer = win.setTimeout(() => reject(new Error("Razorpay checkout took too long to load.")), timeoutMs);
    const loaded = () => {
      win.clearTimeout(timer);
      if (win.Razorpay) resolve(win.Razorpay);
      else reject(new Error("Razorpay checkout is unavailable."));
    };
    const failed = () => {
      win.clearTimeout(timer);
      reject(new Error("Failed to load Razorpay checkout SDK."));
    };
    const existing = doc.querySelector(`script[src="${RAZORPAY_CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", loaded, { once: true });
      existing.addEventListener("error", failed, { once: true });
      return;
    }
    const script = doc.createElement("script");
    script.src = RAZORPAY_CHECKOUT_SRC;
    script.onload = loaded;
    script.onerror = failed;
    doc.body.appendChild(script);
  });
}

/** User-facing sentence for a refused or failed checkout (no hue, no codes). */
export function platformCheckoutError(err) {
  const disabled = featureDisabledDetail(err);
  if (disabled) return disabled.reason || PLAN_UNAVAILABLE_REASON;
  const data = err?.response?.data;
  const code = data?.code || data?.errors?.code;
  if (code === "already_subscribed") return "You already have this membership. Manage it from your Console.";
  if (code === "already_owned") return "You already own this plan.";
  if (isPaymentGatewayUnavailable(err) || (Number(err?.response?.status) === 503 && code === "upstream_unavailable")) {
    return PAYMENTS_PAUSED_MESSAGE;
  }
  if (code === "plan_unavailable") return text(data?.detail || data?.errors?.detail) || PLAN_UNAVAILABLE_REASON;
  return text(data?.errors?.detail || data?.detail || data?.message) || text(err?.message) || "Unable to start payment.";
}

/**
 * Open Razorpay Checkout for a platform plan and verify the result.
 * Resolves { status: "paid" | "dismissed" | "failed", data? }; rejects when
 * the order/subscription cannot be created (use platformCheckoutError).
 */
export async function startPlatformCheckout(
  plan,
  {
    api = apiClient,
    loadCheckout = loadRazorpayCheckout,
    idempotencyKey = createPlanIdempotencyKey(),
    brandName = "",
    prefill = {},
    retrySleep = undefined,
  } = {}
) {
  const gate = platformPlanGate(plan);
  if (gate.blocked) {
    const error = new Error(gate.reason);
    error.code = gate.code;
    throw error;
  }
  const subscription = isSubscriptionPlan(plan);
  const Razorpay = await loadCheckout();
  const headers = { "Idempotency-Key": idempotencyKey };
  const created = apiData(
    await api.post(subscription ? "/payment/subscriptions/" : "/payment/platform/orders/", { plan_key: plan.key }, { headers })
  );
  const key = created?.key_id;
  if (!key) throw new Error("Razorpay is not configured for this environment.");
  if (subscription ? !created?.subscription_id : !created?.order_id) {
    throw new Error("Checkout could not be started. Refresh the page and try again.");
  }

  return new Promise((resolve) => {
    const options = {
      key,
      name: brandName || created.name || "",
      description: created.description || plan.title || "",
      theme: { color: "#111111" },
      prefill: { ...(created.prefill || {}), ...prefill },
      notes: { plan_key: plan.key },
      handler: async (response) => {
        const verify = () => (subscription
          ? api.post("/payment/subscriptions/verify/", {
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_subscription_id: response.razorpay_subscription_id,
              razorpay_signature: response.razorpay_signature,
            })
          : api.post("/payment/platform/orders/verify/", {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            }));
        try {
          // Razorpay already took the money: retry transient failures
          // (verify is idempotent on the server).
          const verified = await withPaymentRetries(verify, { sleep: retrySleep });
          resolve({ status: "paid", data: apiData(verified) });
        } catch (err) {
          if (isTransientPaymentError(err)) {
            // Still unconfirmed after the retries: the webhook/reconciliation
            // finalizes it. Never tell a paying buyer the payment failed.
            resolve({ status: "pending", error: PAYMENT_PENDING_MESSAGE });
            return;
          }
          resolve({ status: "failed", error: platformCheckoutError(err) });
        }
      },
      modal: { ondismiss: () => resolve({ status: "dismissed" }) },
    };
    if (subscription) options.subscription_id = created.subscription_id;
    else {
      options.order_id = created.order_id;
      options.amount = created.amount_paise;
      options.currency = created.currency || "INR";
    }
    const checkout = new Razorpay(options);
    checkout.on?.("payment.failed", () =>
      resolve({ status: "failed", error: "Payment was not completed. No access was granted; you can try again." })
    );
    checkout.open();
  });
}
