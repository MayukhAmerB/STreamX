import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { availablePaymentPlans } from "./PaymentPlanPicker";
import PaymentPlanPicker from "./PaymentPlanPicker";

const configuredCourse = {
  title: "Advanced Web Application Pentesting",
  duration: "6 months",
  course_card_features: [
    { icon: "live", title: "48 instructor-led classes" },
    { icon: "recording", title: "Permanent recorded access" },
    { icon: "chat", title: "Live session chat" },
    { icon: "support", title: "24/7 team chat support" },
  ],
  installment_payment_enabled: true,
  monthly_price: "4299",
  installments_required: 6,
  installment_access_days: 30,
  bundle_payment_enabled: true,
  bundle_price: "10999",
  bundle_installments: 2,
  bundle_access_days: 90,
  full_payment_enabled: true,
  price: "18999",
};

describe("admin-controlled payment plans", () => {
  it("uses all three configured prices and installment counts", () => {
    const plans = availablePaymentPlans(configuredCourse);
    expect(Object.fromEntries(plans.map((plan) => [plan.id, plan.total]))).toEqual({
      monthly: 25794,
      full: 18999,
      bundle: 21998,
    });
  });

  it("hides disabled or unpriced plans including unset OSINT pricing", () => {
    expect(availablePaymentPlans({ full_payment_enabled: true, price: "0", installment_payment_enabled: false, monthly_price: "1500" })).toEqual([]);
  });

  it("renders the reference-style plan hierarchy with truthful server terms", () => {
    const html = renderToStaticMarkup(
      <PaymentPlanPicker
        course={configuredCourse}
        value="full"
        onChange={() => {}}
        onContinue={() => {}}
      />,
    );

    expect(html).toContain("PLAN 1");
    expect(html).toContain("PLAN 2");
    expect(html).toContain("PLAN 3");
    expect(html).toContain("Monthly");
    expect(html).toContain("One-Time");
    expect(html).toContain("3-Month Bundle");
    expect(html).toContain("Lifetime access");
    expect(html).toContain("90-day access window");
    expect(html).toContain("48 instructor-led classes");
    expect(html).toContain("Enroll Now");
    expect(html).not.toContain("all future batches");
    expect(html).not.toContain("Most popular");
  });

  it("announces unavailable enrollment consistently with the disabled label", () => {
    const html = renderToStaticMarkup(
      <PaymentPlanPicker
        course={configuredCourse}
        value="full"
        onChange={() => {}}
        disabled
      />,
    );

    expect(html).toContain("Enrollment unavailable");
    expect(html).toContain("plan enrollment is unavailable");
    expect(html).not.toContain("aria-label=\"Enroll with");
  });
});
