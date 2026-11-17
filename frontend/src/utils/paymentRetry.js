// Retrying payment confirmation after the money has moved.
//
// A Razorpay success callback means the buyer has paid. If our verify call
// then fails for a transient reason (payment gateway briefly unreachable, a
// 502/503/504 from the proxy, rate limiting, the phone dropping off the
// network), giving up would show "failed" for a successful payment. Instead
// the call is retried a few times with growing, jittered waits. Verify is
// idempotent on the server, so a retry can never double-charge or
// double-enroll; if every retry fails the server-side webhook/reconciliation
// still finalizes the payment.

const TRANSIENT_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set(["ECONNABORTED", "ERR_NETWORK", "ETIMEDOUT", "ECONNRESET"]);

/** True for failures worth retrying (no answer, timeouts, 429, 5xx). */
export function isTransientPaymentError(error) {
  if (!error) return false;
  const response = error.response;
  if (response) return TRANSIENT_STATUSES.has(Number(response.status));
  return Boolean(error.request) || NETWORK_CODES.has(error.code);
}

/** Wait before retry number `attempt` (0-based): server Retry-After when sent, else 1.5s, 3s, 6s... (+/-25%), capped. */
export function paymentRetryDelayMs(attempt, error, { random = Math.random, capMs = 10000 } = {}) {
  const headers = error?.response?.headers || {};
  const retryAfter = Number(headers["retry-after"] ?? headers["Retry-After"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, capMs);
  }
  const base = Math.min(1500 * 2 ** Math.max(0, attempt), capMs);
  return Math.round(base * (0.75 + random() * 0.5));
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Run `fn` and retry transient failures up to `retries` more times.
 * `onRetry(attempt, delayMs, error)` lets the UI say "still confirming".
 */
export async function withPaymentRetries(fn, { retries = 3, sleep = defaultSleep, onRetry, random } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= retries || !isTransientPaymentError(error)) throw error;
      const delay = paymentRetryDelayMs(attempt, error, random ? { random } : undefined);
      onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
      attempt += 1;
    }
  }
}

/** The server said this checkout key belongs to a different request: make a new one. */
export function isCheckoutKeyReused(error) {
  return Number(error?.response?.status) === 409
    && error?.response?.data?.data?.rotate_checkout_key === true;
}

/** Payments are paused (circuit open / gateway down): nothing was charged. */
export function isPaymentGatewayUnavailable(error) {
  const data = error?.response?.data;
  return Number(error?.response?.status) === 503
    && (data?.errors?.code === "payment_gateway_unavailable" || data?.code === "payment_gateway_unavailable");
}
