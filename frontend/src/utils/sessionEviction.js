// The refresh endpoint answers 401 with errors.code "session_replaced" when a
// newer sign-in on another device took this device's session slot.
export const SESSION_REPLACED_CODE = "session_replaced";

export const SESSION_EVICTED_LOGIN_MESSAGE =
  "This account was signed in on another device. Sign in again to continue here.";

export function isSessionEviction(detail) {
  return detail?.code === SESSION_REPLACED_CODE;
}

// LoginPage returns to location.state.from after a successful sign-in.
export function loginReturnState(location) {
  const pathname = location?.pathname || "/";
  if (pathname === "/login") {
    return { from: "/" };
  }
  return { from: `${pathname}${location?.search || ""}${location?.hash || ""}` };
}
