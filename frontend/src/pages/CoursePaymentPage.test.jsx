import { describe, expect, it } from "vitest";

import {
  checkoutSteps,
  createCheckoutIdempotencyKey,
  hasPermanentCourseAccess,
  shouldRotateCheckoutIntentAfterError,
} from "./CoursePaymentPage";

describe("course checkout flow", () => {
  it("shows the plan catalogue before collecting customer details", () => {
    expect(checkoutSteps.map((step) => step.id)).toEqual([
      "plan",
      "identity",
      "email",
      "contact",
    ]);
  });

  it("creates unique backend-compatible idempotency keys", () => {
    const keys = Array.from({ length: 12 }, () => createCheckoutIdempotencyKey());

    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((key) => {
      expect(key).toMatch(/^[A-Za-z0-9._~-]{8,200}$/);
    });
  });

  it("keeps follow-up installment payments reachable while blocking duplicate lifetime purchases", () => {
    expect(hasPermanentCourseAccess({
      is_enrolled: true,
      enrollment_access_type: "installment",
    })).toBe(false);
    expect(hasPermanentCourseAccess({
      is_enrolled: true,
      enrollment_access_type: "lifetime",
    })).toBe(true);
  });

  it("rotates a checkout key only after an explicit gateway-order failure response", () => {
    expect(shouldRotateCheckoutIntentAfterError({
      response: {
        status: 503,
        data: { data: { rotate_checkout_key: true } },
      },
    })).toBe(true);
    expect(shouldRotateCheckoutIntentAfterError({ response: { status: 503 } })).toBe(false);
    expect(shouldRotateCheckoutIntentAfterError({
      response: {
        status: 503,
        data: { data: { retry_same_checkout: true } },
      },
    })).toBe(false);
    expect(shouldRotateCheckoutIntentAfterError({ response: { status: 400 } })).toBe(false);
    expect(shouldRotateCheckoutIntentAfterError(new Error("network interrupted"))).toBe(false);
  });
});
