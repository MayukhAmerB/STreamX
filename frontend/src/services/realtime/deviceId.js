// A stable, random id for this browser, sent with every live-class join.
// The server derives the LiveKit identity from it (with the session slot), so
// a rejoin replaces this device's stale connection instead of leaving a ghost
// participant that counts against the meeting capacity.
export const DEVICE_ID_STORAGE_KEY = "alsyed.realtime.deviceId";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

let memoryDeviceId = "";

function randomId(random = Math.random) {
  const cryptoApi = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi?.randomUUID) {
    return `web-${cryptoApi.randomUUID().replace(/-/g, "")}`;
  }
  let value = "web-";
  while (value.length < 28) {
    value += Math.floor(random() * 36).toString(36);
  }
  return value;
}

function defaultStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isValidDeviceId(value) {
  return DEVICE_ID_PATTERN.test(String(value || ""));
}

export function getRealtimeDeviceId(storage = defaultStorage(), random = Math.random) {
  try {
    const stored = storage?.getItem(DEVICE_ID_STORAGE_KEY);
    if (isValidDeviceId(stored)) return stored;
    const created = randomId(random);
    storage?.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // Storage blocked: stable for this page load at least.
    if (!memoryDeviceId) memoryDeviceId = randomId(random);
    return memoryDeviceId;
  }
}
