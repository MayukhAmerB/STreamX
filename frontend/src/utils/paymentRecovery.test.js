import { describe, expect, it } from "vitest";

function createMemoryStorage() {
  const values = new Map();

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

describe("payment checkout recovery", () => {
  it("restores the stable checkout key without persisting gateway credentials", async () => {
    const { loadCheckoutRecovery, saveCheckoutRecovery } = await import(
      "./paymentRecovery"
    );
    const storage = createMemoryStorage();
    const capturedCheckout = {
      idempotencyKey: "checkout-stable-after-capture-0001",
      plan: "monthly",
      applicationReference: "b1354157-05a8-4bc4-b907-d3af9d353ae8",
      pendingVerification: {
        course_id: 19,
        checkout_reference: "b1354157-05a8-4bc4-b907-d3af9d353ae8",
        razorpay_order_id: "order_captured_0001",
        razorpay_payment_id: "pay_captured_0001",
        razorpay_signature: "captured-signature-0001",
      },
    };

    saveCheckoutRecovery(storage, 19, capturedCheckout);

    // Loading again represents a fresh CoursePaymentPage mount. The stable key
    // lets the backend reconcile the existing order without retaining a
    // Razorpay payment ID or signature in browser storage.
    const recoveredAfterRemount = loadCheckoutRecovery(storage, 19);

    expect(recoveredAfterRemount).toEqual({
      idempotencyKey: capturedCheckout.idempotencyKey,
      pendingVerification: null,
      plan: "monthly",
      applicationReference: "b1354157-05a8-4bc4-b907-d3af9d353ae8",
    });
    expect(recoveredAfterRemount.pendingVerification).toBeNull();
    expect(recoveredAfterRemount.idempotencyKey).toBe(
      "checkout-stable-after-capture-0001",
    );
    expect(loadCheckoutRecovery(storage, 20)).toBeNull();
  });

  it("clears payment recovery but preserves the application for a later installment", async () => {
    const {
      clearCheckoutRecovery,
      loadCheckoutRecovery,
      loadCourseApplicationReference,
      saveCheckoutRecovery,
      saveCourseApplicationReference,
    } = await import("./paymentRecovery");
    const storage = createMemoryStorage();
    const applicationReference = "b1354157-05a8-4bc4-b907-d3af9d353ae8";
    const capturedCheckout = {
      idempotencyKey: "checkout-clear-after-verification-0001",
      plan: "monthly",
      applicationReference,
      pendingVerification: {
        course_id: 19,
        checkout_reference: "4e8565db-204f-4be9-b196-a31813809d60",
        razorpay_order_id: "order_verified_0001",
        razorpay_payment_id: "pay_verified_0001",
        razorpay_signature: "verified-signature-0001",
      },
    };
    saveCheckoutRecovery(storage, 19, capturedCheckout);
    saveCourseApplicationReference(storage, 19, applicationReference);

    clearCheckoutRecovery(storage, 19);

    expect(loadCheckoutRecovery(storage, 19)).toBeNull();
    expect(loadCourseApplicationReference(storage, 19)).toBe(applicationReference);
  });
});

describe("unfinished checkout after a page refresh", () => {
  it("remembers when an order was opened and flags it for a day", async () => {
    const { hasRecentUnfinishedCheckout, loadCheckoutRecovery, saveCheckoutRecovery } = await import(
      "./paymentRecovery"
    );
    const storage = createMemoryStorage();
    const startedAt = Date.UTC(2026, 10, 16, 10, 0, 0);
    saveCheckoutRecovery(storage, 7, {
      idempotencyKey: "checkout-refresh-mid-payment-0001",
      plan: "full",
      orderStartedAt: startedAt,
    });
    const recovered = loadCheckoutRecovery(storage, 7);
    expect(recovered.orderStartedAt).toBe(startedAt);
    expect(hasRecentUnfinishedCheckout(recovered, startedAt + 60 * 60 * 1000)).toBe(true);
    expect(hasRecentUnfinishedCheckout(recovered, startedAt + 25 * 60 * 60 * 1000)).toBe(false);
    expect(hasRecentUnfinishedCheckout({ idempotencyKey: "x" }, startedAt)).toBe(false);
  });

  it("drops a malformed timestamp", async () => {
    const { loadCheckoutRecovery, saveCheckoutRecovery } = await import("./paymentRecovery");
    const storage = createMemoryStorage();
    saveCheckoutRecovery(storage, 8, { idempotencyKey: "checkout-bad-timestamp-0001", orderStartedAt: "soon" });
    expect(loadCheckoutRecovery(storage, 8)).toEqual({ idempotencyKey: "checkout-bad-timestamp-0001", pendingVerification: null });
  });
});
