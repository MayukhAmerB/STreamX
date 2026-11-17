import { describe, expect, it, vi } from "vitest";

import {
  isCheckoutKeyReused,
  isPaymentGatewayUnavailable,
  isTransientPaymentError,
  paymentRetryDelayMs,
  withPaymentRetries,
} from "./paymentRetry";

const httpError = (status, data = {}, headers = {}) => ({ response: { status, data, headers } });

describe("isTransientPaymentError", () => {
  it("retries gateway outages, proxy errors, rate limits and network drops", () => {
    [429, 500, 502, 503, 504].forEach((status) => expect(isTransientPaymentError(httpError(status))).toBe(true));
    expect(isTransientPaymentError({ request: {}, code: "ERR_NETWORK" })).toBe(true);
    expect(isTransientPaymentError({ code: "ECONNABORTED" })).toBe(true);
  });

  it("never retries a decision the server made (bad signature, conflict, not found)", () => {
    [400, 401, 403, 404, 409].forEach((status) => expect(isTransientPaymentError(httpError(status))).toBe(false));
    expect(isTransientPaymentError(new Error("Razorpay is not configured"))).toBe(false);
    expect(isTransientPaymentError(null)).toBe(false);
  });
});

describe("paymentRetryDelayMs", () => {
  it("honours Retry-After and caps it", () => {
    expect(paymentRetryDelayMs(0, httpError(503, {}, { "retry-after": "4" }))).toBe(4000);
    expect(paymentRetryDelayMs(0, httpError(503, {}, { "retry-after": "600" }))).toBe(10000);
  });

  it("backs off exponentially with jitter", () => {
    expect(paymentRetryDelayMs(0, null, { random: () => 0.5 })).toBe(1500);
    expect(paymentRetryDelayMs(1, null, { random: () => 0.5 })).toBe(3000);
    expect(paymentRetryDelayMs(2, null, { random: () => 0 })).toBe(4500);
    expect(paymentRetryDelayMs(10, null, { random: () => 1 })).toBe(12500);
  });
});

describe("withPaymentRetries", () => {
  it("retries a transient failure and returns the eventual success", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce({ request: {}, code: "ERR_NETWORK" })
      .mockResolvedValueOnce("verified");
    await expect(withPaymentRetries(fn, { sleep, onRetry, random: () => 0.5 })).resolves.toBe("verified");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
  });

  it("stops after the retry budget", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(502));
    await expect(withPaymentRetries(fn, { retries: 2, sleep: async () => {} })).rejects.toMatchObject({ response: { status: 502 } });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a signature failure", async () => {
    const fn = vi.fn().mockRejectedValue(httpError(400));
    await expect(withPaymentRetries(fn, { sleep: async () => {} })).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("server signals", () => {
  it("recognises a reused checkout key and paused payments", () => {
    expect(isCheckoutKeyReused(httpError(409, { data: { rotate_checkout_key: true } }))).toBe(true);
    expect(isCheckoutKeyReused(httpError(409, { data: null }))).toBe(false);
    expect(isPaymentGatewayUnavailable(httpError(503, { errors: { code: "payment_gateway_unavailable" } }))).toBe(true);
    expect(isPaymentGatewayUnavailable(httpError(503, { errors: { code: "other" } }))).toBe(false);
  });
});
