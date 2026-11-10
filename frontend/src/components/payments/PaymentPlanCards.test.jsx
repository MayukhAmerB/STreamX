import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PaymentPlanPicker, { availablePaymentPlans, defaultPaymentPlanId } from "../PaymentPlanPicker";
import { fire, renderTree, textOf } from "../../test-utils/renderTree";

const monthly = {
  plan: "monthly",
  title: "Monthly",
  subtitle: "Pay as you learn",
  amount: "1500.00",
  currency: "INR",
  price_label: "₹1,500 / month",
  total_label: "₹4,500 over 3 months",
  installments: 3,
  access_label: "30-day access per payment",
  features: ["Live classes every weekend", "Recordings for 30 days"],
  badge: null,
  highlighted: false,
  cta_label: "Start monthly",
  order: 1,
  available: true,
  unavailable_reason: null,
};
const full = {
  plan: "full",
  title: "One-time",
  subtitle: "Best value",
  amount: "3500.00",
  currency: "INR",
  price_label: "₹3,500",
  total_label: null,
  installments: null,
  access_label: "Lifetime access",
  features: ["Everything in Monthly", "Lifetime recordings"],
  badge: "Most popular",
  highlighted: true,
  cta_label: "Enroll now",
  order: 2,
  available: true,
  unavailable_reason: null,
};
const batchPass = {
  ...full,
  plan: "batch_pass",
  title: "All future batches",
  subtitle: null,
  amount: "4500.00",
  price_label: "₹4,500",
  access_label: "Lifetime + every future batch",
  features: ["Every future batch"],
  badge: null,
  highlighted: false,
  cta_label: "Get the pass",
  order: 3,
};
const bundle = {
  ...monthly,
  plan: "bundle",
  title: "3-month bundle",
  amount: "4000.00",
  price_label: "₹4,000 / installment",
  total_label: "₹8,000 in 2 payments",
  installments: 2,
  cta_label: "Choose bundle",
  order: 4,
  available: false,
  unavailable_reason: "Bundle seats for this batch are sold out.",
};

const courseWith = (plans, perRow) => ({
  id: 29,
  title: "OSINT Professional Training Program",
  purchase_available: true,
  // Legacy fields still present on the response; the cards must ignore them.
  full_payment_enabled: true,
  price: "9999",
  payment_plans: plans,
  ...(perRow ? { payment_cards_per_row: perRow } : {}),
});

const render = (course, props = {}) =>
  renderToStaticMarkup(<PaymentPlanPicker course={course} value={defaultPaymentPlanId(course)} onChange={() => {}} {...props} />);

const countMatches = (html, pattern) => (html.match(pattern) || []).length;

describe("admin-configured payment plan cards", () => {
  it.each([
    [[monthly, full], 2],
    [[monthly, full, batchPass], 3],
    [[monthly, full, batchPass, bundle], 4],
  ])("renders %#: every configured card with a grid of matching columns", (plans, columns) => {
    const html = render(courseWith(plans, columns));
    expect(countMatches(html, /data-plan-card="true"/g)).toBe(plans.length);
    expect(html).toContain(`ppc-grid--cols-${columns}`);
    expect(html).toContain(`data-columns="${columns}"`);
    plans.forEach((plan) => expect(html).toContain(`>${plan.title}</h3>`));
    // Admin copy, not the legacy price fields.
    expect(html).not.toContain("9,999");
    expect(html).not.toContain("payment-plan-grid");
  });

  it("derives the column count from the cards when payment_cards_per_row is missing", () => {
    expect(render(courseWith([monthly, full, batchPass]))).toContain("ppc-grid--cols-3");
  });

  it("splits the price, shows totals, access and features from the contract", () => {
    const html = render(courseWith([monthly, full], 2));
    expect(html).toContain('<span class="ppc-amount">₹1,500</span><span class="ppc-interval">/ month</span>');
    expect(html).toContain("₹4,500 over 3 months");
    expect(html).toContain("30-day access per payment");
    expect(html).toContain("Live classes every weekend");
    expect(html).toContain("Pay as you learn");
    expect(html).toContain("Start monthly");
  });

  it("elevates the highlighted card with its badge and preselects it", () => {
    const course = courseWith([monthly, full, batchPass], 3);
    expect(defaultPaymentPlanId(course)).toBe("full");
    const html = render(course);
    expect(html).toMatch(/class="ppc-card ppc-card--highlighted ppc-card--selected ppc-card--badged" data-plan-card="true" data-plan="full"/);
    expect(html).toContain('<span class="ppc-badge">Most popular</span>');
    expect(countMatches(html, /ppc-badge"/g)).toBe(1);
    expect(countMatches(html, /checked=""/g)).toBe(1);
  });

  it("disables unavailable cards and shows the reason", () => {
    const course = courseWith([monthly, full, batchPass, bundle], 4);
    const html = render(course);
    expect(html).toMatch(/class="ppc-card ppc-card--unavailable" data-plan-card="true" data-plan="bundle"/);
    expect(html).toContain("Bundle seats for this batch are sold out.");
    expect(html).toMatch(/<input id="[^"]*-plan-bundle"[^>]*disabled=""[^>]*value="bundle"\/>/);
    expect(html).toContain('aria-label="3-month bundle plan is unavailable"');
    // Unavailable plans can never be checked out.
    expect(availablePaymentPlans(course).map((plan) => plan.id)).toEqual(["monthly", "full", "batch_pass"]);
  });

  it("disables every call to action when purchase is closed", () => {
    const html = render(courseWith([monthly, full], 2), { disabled: true });
    expect(countMatches(html, /Enrollment unavailable/g)).toBe(2);
    expect(html).not.toContain("Start monthly</span>");
  });

  it("shows the empty state when the admin enabled no plans", () => {
    const html = render(courseWith([], 2));
    expect(html).toContain("Enrollment pricing will be announced.");
    expect(html).not.toContain("payment-plan-grid");
  });

  it("falls back to today's cards when the backend does not send payment_plans", () => {
    const legacyCourse = {
      purchase_available: true,
      installment_payment_enabled: true,
      monthly_price: "1500",
      installments_required: 3,
      full_payment_enabled: true,
      price: "3500",
    };
    expect(defaultPaymentPlanId(legacyCourse)).toBe("full");
    const html = render(legacyCourse);
    expect(html).toContain("payment-plan-grid");
    expect(html).toContain("PLAN 1");
    expect(html).toContain("One-Time");
    expect(html).toContain("Enroll Now");
    expect(html).not.toContain("ppc-grid");
  });

  it("selects with the radio and continues with the card's call to action", async () => {
    const onChange = vi.fn();
    const onContinue = vi.fn();
    const course = courseWith([monthly, full, batchPass, bundle], 4);
    const view = await renderTree(
      <PaymentPlanPicker course={course} value="full" onChange={onChange} onContinue={onContinue} />,
    );

    const radio = (id) => view.find((node) => node.type === "input" && node.props.value === id);
    await fire(radio("batch_pass"), "onChange");
    expect(onChange).toHaveBeenLastCalledWith("batch_pass");
    expect(onContinue).not.toHaveBeenCalled();

    // Enter on a focused radio continues with that plan.
    await fire(radio("monthly"), "onKeyDown", { key: "Enter" });
    expect(onContinue).toHaveBeenLastCalledWith("monthly");

    const cta = view.find((node) => node.type === "button" && textOf(node) === "Get the pass");
    await fire(cta, "onClick");
    expect(onChange).toHaveBeenLastCalledWith("batch_pass");
    expect(onContinue).toHaveBeenLastCalledWith("batch_pass");

    expect(radio("bundle").props.disabled).toBe(true);
    const unavailableCta = view.find((node) => node.type === "button" && textOf(node) === "Unavailable");
    expect(unavailableCta.props.disabled).toBe(true);
    await fire(radio("bundle"), "onKeyDown", { key: "Enter" });
    expect(onContinue).not.toHaveBeenLastCalledWith("bundle");
    await view.unmount();
  });
});
