import { describe, expect, it } from "vitest";
import {
  configuredCourseFeeLabel,
  configuredPaymentPlanCards,
  hasConfiguredPaymentPlans,
  normalizePaymentPlan,
  paymentCardColumns,
  splitPriceLabel,
} from "./paymentPlans";

const card = (plan, extra = {}) => ({
  plan,
  title: `${plan} title`,
  subtitle: null,
  amount: "1500.00",
  currency: "INR",
  price_label: "₹1,500",
  total_label: null,
  installments: null,
  access_label: "Lifetime access",
  features: [],
  badge: null,
  highlighted: false,
  cta_label: "Enroll now",
  order: 0,
  available: true,
  unavailable_reason: null,
  ...extra,
});

describe("payment plan contract normalisation", () => {
  it("only treats an array as the configured contract (missing field = legacy backend)", () => {
    expect(hasConfiguredPaymentPlans({})).toBe(false);
    expect(hasConfiguredPaymentPlans({ payment_plans: null })).toBe(false);
    expect(hasConfiguredPaymentPlans({ payment_plans: [] })).toBe(true);
  });

  it("parses decimal-string amounts and keeps the checkout plan identifier", () => {
    const plan = normalizePaymentPlan(card("monthly", { amount: "1500.00", price_label: "₹1,500 / month", installments: 3, total_label: "₹4,500 over 3 months" }));
    expect(plan).toMatchObject({
      id: "monthly",
      amount: 1500,
      currency: "INR",
      priceLabel: "₹1,500 / month",
      installments: 3,
      totalLabel: "₹4,500 over 3 months",
      available: true,
      unavailableReason: "",
    });
  });

  it("drops unknown plan identifiers and duplicates, then sorts by admin order", () => {
    const plans = configuredPaymentPlanCards({
      payment_plans: [
        card("full", { order: 2 }),
        card("lifetime_gold", { order: 0 }),
        card("monthly", { order: 1 }),
        card("full", { order: 3, title: "Duplicate" }),
        null,
      ],
    });
    expect(plans.map((plan) => [plan.id, plan.number])).toEqual([["monthly", 1], ["full", 2]]);
    expect(plans[1].title).toBe("full title");
  });

  it("fills safe defaults for missing copy and marks unpriced plans unavailable", () => {
    const plan = normalizePaymentPlan({ plan: "batch_pass", amount: null, features: ["  Live  classes ", "", null] });
    expect(plan).toMatchObject({
      title: "All future batches",
      ctaLabel: "Enroll now",
      priceLabel: "To be announced",
      available: false,
      unavailableReason: "Pricing will be announced soon.",
      features: ["Live classes"],
    });
    const closed = normalizePaymentPlan(card("bundle", { available: false, unavailable_reason: "Batch is full" }));
    expect(closed).toMatchObject({ available: false, unavailableReason: "Batch is full" });
    expect(normalizePaymentPlan(card("bundle", { available: false })).unavailableReason).toBe("This plan is not available right now.");
  });

  it("formats a price label from the amount when the backend leaves it empty", () => {
    expect(normalizePaymentPlan(card("full", { amount: "3500.00", price_label: "" })).priceLabel).toBe("₹3,500");
  });

  it("splits the price label into the figure and its interval", () => {
    expect(splitPriceLabel("₹1,500 / month")).toEqual({ amount: "₹1,500", suffix: "/ month" });
    expect(splitPriceLabel("₹18,999")).toEqual({ amount: "₹18,999", suffix: "" });
    expect(splitPriceLabel("₹1,500.50/installment")).toEqual({ amount: "₹1,500.50", suffix: "/installment" });
    expect(splitPriceLabel("Free")).toEqual({ amount: "Free", suffix: "" });
  });

  it("uses the admin's cards per row, else the card count clamped to 2-4", () => {
    expect(paymentCardColumns({ payment_cards_per_row: 2 }, 4)).toBe(2);
    expect(paymentCardColumns({ payment_cards_per_row: 3 }, 3)).toBe(3);
    expect(paymentCardColumns({ payment_cards_per_row: 4 }, 4)).toBe(4);
    expect(paymentCardColumns({ payment_cards_per_row: 4 }, 2)).toBe(2);
    expect(paymentCardColumns({ payment_cards_per_row: 7 }, 3)).toBe(3);
    expect(paymentCardColumns({}, 4)).toBe(4);
    expect(paymentCardColumns({}, 2)).toBe(2);
    expect(paymentCardColumns({}, 1)).toBe(1);
  });

  it("headlines the highlighted available plan on course detail pages", () => {
    expect(configuredCourseFeeLabel({})).toBe("");
    expect(configuredCourseFeeLabel({
      payment_plans: [
        card("monthly", { price_label: "₹1,500 / month" }),
        card("full", { price_label: "₹3,500" }),
        card("batch_pass", { price_label: "₹4,500", highlighted: true, available: false }),
      ],
    })).toBe("₹3,500");
    expect(configuredCourseFeeLabel({
      payment_plans: [card("monthly", { price_label: "₹1,500 / month" }), card("bundle", { price_label: "₹5,000", highlighted: true })],
    })).toBe("₹5,000");
  });
});
