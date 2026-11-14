// The refresh endpoint answers 401 with errors.code "session_replaced" when a
// newer sign-in on another device took this device's session slot.
export const SESSION_REPLACED_CODE = "session_replaced";

export const SESSION_EVICTED_LOGIN_MESSAGE =
  "This account was signed in on another device. Sign in again to continue here.";

export function isSessionEviction(detail) {
  return detail?.code === SESSION_REPLACED_CODE;
}

// A device evicted mid-class may finish that class (apps/users/live_grace.py):
// every response to it carries "X-Session-State: live-grace" until the class
// ends, and its first refresh after that is rejected with errors.reason
// "live_class_ended".
export const SESSION_STATE_HEADER = "x-session-state";
export const LIVE_GRACE_STATE = "live-grace";
export const LIVE_CLASS_ENDED_REASON = "live_class_ended";

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    if (value != null) return String(value);
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(headers[key] ?? "") : "";
}

export function isLiveGraceResponse(response) {
  return headerValue(response?.headers, SESSION_STATE_HEADER).trim().toLowerCase() === LIVE_GRACE_STATE;
}

/** Evicted, but this device may finish the live class it is in. */
export function isLiveGraceEviction(detail) {
  return isSessionEviction(detail) && detail?.liveGrace === true;
}

/** Signed out because the class this evicted device was finishing ended. */
export function isLiveClassEndedEviction(detail) {
  return isSessionEviction(detail) && detail?.reason === LIVE_CLASS_ENDED_REASON;
}

// LoginPage returns to location.state.from after a successful sign-in.
export function loginReturnState(location) {
  const pathname = location?.pathname || "/";
  if (pathname === "/login") {
    return { from: "/" };
  }
  return { from: `${pathname}${location?.search || ""}${location?.hash || ""}` };
}
