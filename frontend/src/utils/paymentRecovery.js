const STORAGE_PREFIX = "alsyed:payment-checkout:v1";
const APPLICATION_STORAGE_PREFIX = "alsyed:course-application:v1";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{8,200}$/;
const APPLICATION_REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageKey(courseId) {
  const normalizedCourseId = Number(courseId);
  return Number.isSafeInteger(normalizedCourseId) && normalizedCourseId > 0
    ? `${STORAGE_PREFIX}:${normalizedCourseId}`
    : "";
}

function applicationStorageKey(courseId) {
  const normalizedCourseId = Number(courseId);
  return Number.isSafeInteger(normalizedCourseId) && normalizedCourseId > 0
    ? `${APPLICATION_STORAGE_PREFIX}:${normalizedCourseId}`
    : "";
}

function normalizeApplicationReference(value) {
  return typeof value === "string" && APPLICATION_REFERENCE_PATTERN.test(value)
    ? value
    : "";
}

function normalizeRecovery(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    typeof value.idempotencyKey !== "string"
    || !IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey)
  ) {
    return null;
  }
  // The stable request key is enough for server-side reconciliation. Never
  // persist Razorpay payment IDs or signatures in browser storage.
  const plan = ["full", "monthly", "bundle"].includes(value.plan)
    ? value.plan
    : undefined;
  const applicationReference = (
    typeof value.applicationReference === "string"
    && APPLICATION_REFERENCE_PATTERN.test(value.applicationReference)
  ) ? value.applicationReference : undefined;
  return {
    idempotencyKey: value.idempotencyKey,
    pendingVerification: null,
    ...(plan ? { plan } : {}),
    ...(applicationReference ? { applicationReference } : {}),
  };
}

export function loadCheckoutRecovery(storage, courseId) {
  const key = storageKey(courseId);
  if (!storage || !key) return null;
  try {
    const serialized = storage.getItem(key);
    if (!serialized) return null;
    const parsed = JSON.parse(serialized);
    const recovery = normalizeRecovery(parsed);
    if (!recovery) storage.removeItem(key);
    else if (parsed.pendingVerification) storage.setItem(key, JSON.stringify(recovery));
    return recovery;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage can be blocked by browser privacy settings. Checkout still works
      // in-memory for the current page.
    }
    return null;
  }
}

export function saveCheckoutRecovery(storage, courseId, value) {
  const key = storageKey(courseId);
  const recovery = normalizeRecovery(value);
  if (!storage || !key || !recovery) return false;
  try {
    storage.setItem(key, JSON.stringify(recovery));
    return true;
  } catch {
    return false;
  }
}

export function clearCheckoutRecovery(storage, courseId) {
  const key = storageKey(courseId);
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function loadCourseApplicationReference(storage, courseId) {
  const key = applicationStorageKey(courseId);
  if (!storage || !key) return "";
  try {
    const reference = normalizeApplicationReference(storage.getItem(key));
    if (!reference) storage.removeItem(key);
    return reference;
  } catch {
    return "";
  }
}

export function saveCourseApplicationReference(storage, courseId, value) {
  const key = applicationStorageKey(courseId);
  const reference = normalizeApplicationReference(value);
  if (!storage || !key || !reference) return false;
  try {
    storage.setItem(key, reference);
    return true;
  } catch {
    return false;
  }
}
