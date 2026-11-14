import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AuthContext } from "../../context/AuthContext";
import PlatformPlanCheckout from "./PlatformPlanCheckout";
import {
  PLAN_UNAVAILABLE_REASON,
  PRICE_AT_LAUNCH_REASON,
  isSubscriptionPlan,
  platformCheckoutError,
  platformPlanGate,
  startPlatformCheckout,
} from "./platformCheckout";

const membership = { key: "ctf_labs_monthly", title: "CTF Labs membership", billing_period: "month", price_inr: "1649.00", state: "available", family: "osint" };
const lifetime = { key: "pentesting_lifetime", title: "Lifetime", kind: "one_time", price_inr: "8399.00", state: "available", family: "pentesting" };

function fakeRazorpay() {
  const instances = [];
  class Razorpay {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      instances.push(this);
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    open() {}
  }
  return { Razorpay, instances };
}

describe("platformPlanGate", () => {
  it("blocks every state that is not available, with the plan's reason", () => {
    expect(platformPlanGate({ ...membership, state: "coming_soon", reason: "Opens soon." })).toMatchObject({ blocked: true, reason: "Opens soon." });
    expect(platformPlanGate({ ...membership, state: "unavailable", reason: "" })).toMatchObject({ blocked: true, reason: PLAN_UNAVAILABLE_REASON });
    expect(platformPlanGate(null).blocked).toBe(true);
  });

  it("blocks an unconfirmed price (price at launch)", () => {
    expect(platformPlanGate({ ...membership, price_inr: null })).toEqual({ blocked: true, reason: PRICE_AT_LAUNCH_REASON, code: "price_unconfirmed" });
  });

  it("honours the memberships and pentesting switches", () => {
    const gates = { memberships: { enabled: false, reason: "Memberships are not open yet." }, pentesting: { enabled: false, reason: "Pentesting soon." } };
    expect(platformPlanGate(membership, { gates }).reason).toBe("Memberships are not open yet.");
    expect(platformPlanGate(lifetime, { gates }).reason).toBe("Pentesting soon.");
    expect(platformPlanGate(membership, { gates: { memberships: { enabled: true } } }).blocked).toBe(false);
  });

  it("never blocks the Free plan", () => {
    expect(platformPlanGate({ key: "free", state: "available", price_inr: "0.00" }).blocked).toBe(false);
  });

  it("tells subscriptions from one-time plans", () => {
    expect(isSubscriptionPlan(membership)).toBe(true);
    expect(isSubscriptionPlan({ billing_period: "year" })).toBe(true);
    expect(isSubscriptionPlan(lifetime)).toBe(false);
    expect(isSubscriptionPlan({ kind: "subscription" })).toBe(true);
  });
});

describe("startPlatformCheckout", () => {
  it("refuses a gated plan before any network call", async () => {
    const api = { post: vi.fn() };
    await expect(startPlatformCheckout({ ...membership, price_inr: null }, { api, loadCheckout: vi.fn() })).rejects.toThrow(PRICE_AT_LAUNCH_REASON);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("opens a subscription checkout and verifies the signature", async () => {
    const { Razorpay, instances } = fakeRazorpay();
    const api = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ data: { success: true, data: { subscription_id: "sub_1", key_id: "rzp_test", name: "Al Syed" } } })
        .mockResolvedValueOnce({ data: { success: true, data: { subscription: { status: "authenticated" } } } }),
    };
    const pending = startPlatformCheckout(membership, { api, loadCheckout: async () => Razorpay, idempotencyKey: "k1" });
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(api.post).toHaveBeenNthCalledWith(1, "/payment/subscriptions/", { plan_key: "ctf_labs_monthly" }, { headers: { "Idempotency-Key": "k1" } });
    expect(instances[0].options).toMatchObject({ key: "rzp_test", subscription_id: "sub_1" });
    expect(instances[0].options.order_id).toBeUndefined();
    await instances[0].options.handler({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: "sig" });
    await expect(pending).resolves.toEqual({ status: "paid", data: { subscription: { status: "authenticated" } } });
    expect(api.post).toHaveBeenNthCalledWith(2, "/payment/subscriptions/verify/", {
      razorpay_payment_id: "pay_1",
      razorpay_subscription_id: "sub_1",
      razorpay_signature: "sig",
    });
  });

  it("opens a one-time order checkout and reports a dismissal", async () => {
    const { Razorpay, instances } = fakeRazorpay();
    const api = { post: vi.fn().mockResolvedValueOnce({ data: { data: { order_id: "order_1", key_id: "rzp", amount_paise: 839900, currency: "INR" } } }) };
    const pending = startPlatformCheckout(lifetime, { api, loadCheckout: async () => Razorpay, idempotencyKey: "k2" });
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    expect(api.post.mock.calls[0][0]).toBe("/payment/platform/orders/");
    expect(instances[0].options).toMatchObject({ order_id: "order_1", amount: 839900, currency: "INR" });
    instances[0].options.modal.ondismiss();
    await expect(pending).resolves.toEqual({ status: "dismissed" });
  });

  it("turns refusals into calm sentences", () => {
    const refusal = (status, data) => ({ response: { status, data } });
    expect(platformCheckoutError(refusal(403, { code: "feature_disabled", detail: "Not open yet." }))).toBe("Not open yet.");
    expect(platformCheckoutError(refusal(409, { code: "already_subscribed" }))).toMatch(/already have this membership/);
    expect(platformCheckoutError(refusal(409, { code: "already_owned" }))).toMatch(/already own/);
    expect(platformCheckoutError(new Error("Boom"))).toBe("Boom");
  });
});

describe("PlatformPlanCheckout", () => {
  const render = (props, auth = { isAuthenticated: true, user: { email: "a@b.c" } }) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
          <PlatformPlanCheckout {...props} />
        </AuthContext.Provider>
      </MemoryRouter>
    );

  it("shows a disabled plan as a focusable button with the visible reason", () => {
    const markup = render({ plan: { ...membership, state: "coming_soon", reason: "Opens at launch.", cta_label: "Join" } });
    expect(markup).toMatch(/aria-disabled="true"/);
    expect(markup).toContain("Join (coming soon)");
    expect(markup).toContain("Opens at launch.");
  });

  it("sends signed-out visitors to sign in and back", () => {
    const markup = render({ plan: { ...membership, cta_label: "Subscribe" }, returnTo: "/pricing" }, { isAuthenticated: false });
    expect(markup).toContain('href="/login?next=%2Fpricing"');
    expect(markup).toContain("Sign in to subscribe");
  });

  it("offers the live action when the plan is available", () => {
    const markup = render({ plan: { ...membership, cta_label: "Subscribe" } });
    expect(markup).toContain('data-plan="ctf_labs_monthly"');
    expect(markup).not.toContain('aria-disabled="true"');
  });
});
