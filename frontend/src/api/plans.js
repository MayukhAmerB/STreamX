// Platform plans: memberships (Razorpay Subscriptions) and one-time orders
// (contract hackpath/contracts/catalog.md §5). Each call resolves to the
// envelope's `data`; refusals reject with the axios error (403
// `feature_disabled` / `plan_unavailable`, 409 `already_subscribed` /
// `already_owned`): read them with `featureDisabledDetail` from ./client.
import apiClient from "./client";

const data = (response) => {
  const body = response?.data;
  return body && typeof body === "object" && "data" in body ? body.data : body;
};

const idempotent = (key) => (key ? { headers: { "Idempotency-Key": key } } : undefined);

export const createSubscription = (planKey, { idempotencyKey } = {}) =>
  apiClient.post("/payment/subscriptions/", { plan_key: planKey }, idempotent(idempotencyKey)).then(data);

export const verifySubscription = (payload) => apiClient.post("/payment/subscriptions/verify/", payload).then(data);

export const cancelSubscription = (id) =>
  apiClient.post(`/payment/subscriptions/${encodeURIComponent(id)}/cancel/`, { at_cycle_end: true }).then(data);

export const fetchMySubscriptions = () => apiClient.get("/payment/subscriptions/mine/").then(data);

export const createPlatformOrder = (planKey, { idempotencyKey } = {}) =>
  apiClient.post("/payment/platform/orders/", { plan_key: planKey }, idempotent(idempotencyKey)).then(data);

export const verifyPlatformOrder = (payload) => apiClient.post("/payment/platform/orders/verify/", payload).then(data);
