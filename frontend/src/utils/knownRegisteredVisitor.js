const KNOWN_REGISTERED_VISITOR_STORAGE_KEY = "asi:known-registered-visitor:v1";

function getDefaultStorage() {
  return window.localStorage;
}

export function isKnownRegisteredVisitor(getStorage = getDefaultStorage) {
  try {
    return getStorage()?.getItem(KNOWN_REGISTERED_VISITOR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markKnownRegisteredVisitor(getStorage = getDefaultStorage) {
  try {
    getStorage()?.setItem(KNOWN_REGISTERED_VISITOR_STORAGE_KEY, "1");
  } catch {
    // Authentication must still succeed when browser storage is unavailable.
  }
}
