import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act, fire, renderTree, textOf } from "../test-utils/renderTree";

const { getCourse, createPaymentOrder, verifyPayment, post } = vi.hoisted(() => ({
  getCourse: vi.fn(),
  createPaymentOrder: vi.fn(),
  verifyPayment: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../api/courses", () => ({ getCourse }));
vi.mock("../api/payments", () => ({ createPaymentOrder, verifyPayment }));
vi.mock("../api/client", () => ({ default: { post } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { full_name: "Asha Rao", email: "asha.rao@example.com", phone_number: "+91 98765 43210" },
  }),
}));

import CoursePaymentPage from "./CoursePaymentPage";

const plan = (id, extra) => ({
  plan: id,
  subtitle: null,
  currency: "INR",
  total_label: null,
  installments: null,
  access_label: "Lifetime access",
  features: [],
  badge: null,
  highlighted: false,
  cta_label: "Enroll now",
  available: true,
  unavailable_reason: null,
  ...extra,
});

const course = {
  id: 29,
  title: "OSINT Professional Training Program",
  category: "osint",
  purchase_available: true,
  launch_status: "live",
  is_enrolled: false,
  // Legacy price fields deliberately disagree with the admin cards.
  full_payment_enabled: true,
  price: "9999",
  payment_cards_per_row: 3,
  payment_plans: [
    plan("monthly", { title: "Monthly", amount: "1500.00", price_label: "₹1,500 / month", order: 1, cta_label: "Start monthly" }),
    plan("full", { title: "One-time", amount: "3500.00", price_label: "₹3,500", order: 2, highlighted: true, badge: "Most popular" }),
    plan("batch_pass", { title: "All future batches", amount: "4500.00", price_label: "₹4,500", order: 3, cta_label: "Get the pass" }),
  ],
};

let razorpayOptions = null;

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

beforeEach(() => {
  razorpayOptions = null;
  getCourse.mockResolvedValue({ data: { data: course } });
  createPaymentOrder.mockResolvedValue({
    data: {
      data: {
        amount: 450000,
        currency: "INR",
        plan: "batch_pass",
        key_id: "rzp_test_key",
        razorpay_order_id: "order_1",
        checkout_reference: "chk_1",
      },
    },
  });
  globalThis.window = {
    Razorpay: class {
      constructor(options) {
        razorpayOptions = options;
      }
      on() {}
      open() {}
    },
    setTimeout,
    clearTimeout,
  };
});

afterEach(() => {
  delete globalThis.window;
  vi.clearAllMocks();
});

describe("checkout with admin-configured plan cards", () => {
  it("sends the chosen card's plan identifier and checks the card's amount", async () => {
    const view = await renderTree(
      <MemoryRouter initialEntries={["/courses/29/payment"]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/courses/:id/payment" element={<CoursePaymentPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await settle();

    // The highlighted card is preselected; the legacy price is never shown.
    const checked = view.find((node) => node.type === "input" && node.props.checked);
    expect(checked.props.value).toBe("full");
    expect(view.text()).not.toContain("9,999");

    await fire(view.find((node) => node.type === "button" && textOf(node) === "Get the pass"), "onClick");
    expect(view.text()).toContain("Step 2 of 4");
    expect(view.text()).toContain("All future batches - ₹4,500");

    for (let step = 0; step < 2; step += 1) {
      await fire(view.find((node) => node.type === "form"), "onSubmit");
    }
    expect(view.text()).toContain("Step 4 of 4");
    await fire(view.find((node) => node.type === "form"), "onSubmit");
    await settle();

    expect(createPaymentOrder).toHaveBeenCalledTimes(1);
    expect(createPaymentOrder.mock.calls[0][0]).toMatchObject({
      course_id: 29,
      plan: "batch_pass",
      buyer_name: "Asha Rao",
      buyer_email: "asha.rao@example.com",
    });
    // ₹4,500.00 from the card == 450000 paise from the server, so Razorpay opens.
    expect(razorpayOptions).toMatchObject({ amount: 450000, order_id: "order_1", notes: { access_plan: "batch_pass" } });
    await view.unmount();
  });
});
