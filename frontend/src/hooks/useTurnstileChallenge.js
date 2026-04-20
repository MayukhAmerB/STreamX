import { useState } from "react";

export function useTurnstileChallenge(enabled) {
  const [token, setToken] = useState("");
  const [resetSignal, setResetSignal] = useState(0);

  const requireToken = () => {
    if (!enabled || token) {
      return "";
    }
    return "Complete the security check and try again.";
  };

  const payload = token ? { turnstile_token: token } : {};

  const reset = () => {
    setToken("");
    setResetSignal((current) => current + 1);
  };

  return {
    token,
    setToken,
    resetSignal,
    payload,
    requireToken,
    reset,
    expire: () => setToken(""),
  };
}
