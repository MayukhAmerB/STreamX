import { describe, expect, it } from "vitest";
import { availablePaymentPlans } from "./PaymentPlanPicker";

describe("admin-controlled payment plans", () => {
  it("uses all three configured prices and installment counts", () => {
    const plans = availablePaymentPlans({ installment_payment_enabled: true, monthly_price: "4299", installments_required: 6, bundle_payment_enabled: true, bundle_price: "10999", bundle_installments: 2, full_payment_enabled: true, price: "18999" });
    expect(plans.map((plan) => plan.amount * plan.count)).toEqual([25794, 21998, 18999]);
  });
  it("hides disabled or unpriced plans including unset OSINT pricing", () => {
    expect(availablePaymentPlans({ full_payment_enabled: true, price: "0", installment_payment_enabled: false, monthly_price: "1500" })).toEqual([]);
  });
});
