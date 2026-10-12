import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./typedClient", () => ({
  typedApiRequest: vi.fn(),
}));

import { createPaymentOrder } from "./payments";
import { typedApiRequest } from "./typedClient";

describe("payment API", () => {
  beforeEach(() => {
    vi.mocked(typedApiRequest).mockReset();
  });

  it("sends the checkout idempotency key when creating a Razorpay order", () => {
    const payload = {
      course_id: 42,
      plan: "full" as const,
      buyer_name: "Test Student",
      buyer_email: "student@example.com",
      whatsapp_number: "+91 98765 43210",
    };

    createPaymentOrder(payload, "checkout-12345678");

    expect(typedApiRequest).toHaveBeenCalledWith("post", "/payment/create-order/", {
      data: payload,
      headers: { "Idempotency-Key": "checkout-12345678" },
    });
  });
});
