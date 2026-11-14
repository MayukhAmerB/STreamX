import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AUTH_SESSION_EXPIRED_EVENT, resetSessionEviction } from "../api/client";
import {
  fetchAuthConfig,
  fetchCsrfToken,
  fetchCurrentUser,
  acceptTerms as acceptTermsRequest,
  loginUser,
  logoutUser,
} from "../api/auth";
import { apiData, apiMessage } from "../utils/api";
import { markKnownRegisteredVisitor } from "../utils/knownRegisteredVisitor";
import {
  SESSION_EVICTED_LOGIN_MESSAGE,
  isLiveClassEndedEviction,
  isLiveGraceEviction,
  isSessionEviction,
  loginReturnState,
} from "../utils/sessionEviction";
import SessionEvictedDialog from "../components/SessionEvictedDialog";
// Phase 2: an evicted device finishes a playing live class with a banner.
import LiveEvictionBanner from "../components/realtime/LiveEvictionBanner";
import { useLiveClassActive } from "../services/realtime/liveClassGuard";
// UI overhaul (WS-F): what the viewer may use in the Console (Appendix A.1).
import { CAPABILITIES_POLL_MS, CAPABILITIES_STALE_EVENT, fetchCapabilities } from "../features/capabilities/api";
import { noteCapabilities } from "../features/capabilities/reveal";

export const AuthContext = createContext(null);

const buildTimeTurnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || "").trim();

// Mounted only while the dialog is open, beside (never around) the routed page.
// mode "live": the server lets this device finish its live class; "final":
// this device is signed out (classEnded: because that class just ended).
export function SessionEvictionPrompt({ mode = "final", classEnded = false, onUseThisDevice, onSignOut }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [signingOut, setSigningOut] = useState(false);
  const liveClassActive = useLiveClassActive();

  const continueOnThisDevice = () => {
    navigate("/login", { state: loginReturnState(location) });
    onUseThisDevice();
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } catch {
      // logout() has already cleared the local session.
    }
    navigate("/login");
  };

  // While a class plays here the student finishes it with a banner (no modal,
  // no logout); once it has ended the device is signed out with the reason.
  if (liveClassActive && !classEnded) {
    return (
      <LiveEvictionBanner signingOut={signingOut} onUseThisDevice={continueOnThisDevice} onSignOut={signOut} />
    );
  }
  return (
    <SessionEvictedDialog
      open
      variant={classEnded ? "class-ended" : mode === "live" ? "live" : "signed-out"}
      signingOut={signingOut}
      onUseThisDevice={continueOnThisDevice}
      onSignOut={signOut}
    />
  );
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [webPushEnabled, setWebPushEnabled] = useState(false);
  const [webPushPublicKey, setWebPushPublicKey] = useState("");
  const [turnstileEnabled, setTurnstileEnabled] = useState(Boolean(buildTimeTurnstileSiteKey));
  const [turnstileSiteKey, setTurnstileSiteKey] = useState(buildTimeTurnstileSiteKey);
  const [sessionEndedMessage, setSessionEndedMessage] = useState("");
  // null, or { mode: "live" | "final", classEnded } (see SessionEvictionPrompt).
  const [sessionEviction, setSessionEviction] = useState(null);
  const hasBootstrappedRef = useRef(false);
  // Capabilities arrive embedded in the user and are then re-checked on window
  // focus, every 5 minutes and after any 403 feature_disabled (plan §5.4).
  const [capabilities, setCapabilitiesState] = useState(null);
  const capabilitiesJsonRef = useRef("null");
  const capabilitiesRequestRef = useRef(null);
  const userIdRef = useRef(null);

  const setCapabilities = useCallback((next) => {
    const value = next && typeof next === "object" ? next : null;
    const json = JSON.stringify(value);
    if (json === capabilitiesJsonRef.current) {
      return;
    }
    capabilitiesJsonRef.current = json;
    if (value) {
      noteCapabilities(userIdRef.current, value);
    }
    setCapabilitiesState(value);
  }, []);

  const refreshCapabilities = useCallback(() => {
    if (userIdRef.current == null) {
      return Promise.resolve(null);
    }
    if (capabilitiesRequestRef.current) {
      return capabilitiesRequestRef.current;
    }
    const userId = userIdRef.current;
    const request = fetchCapabilities()
      .then((response) => {
        const next = apiData(response, null);
        if (next && userIdRef.current === userId) {
          setCapabilities(next);
        }
        return next;
      })
      .catch(() => null) // keep the last known state; the server still enforces every rule
      .finally(() => {
        capabilitiesRequestRef.current = null;
      });
    capabilitiesRequestRef.current = request;
    return request;
  }, [setCapabilities]);

  function setAuthenticatedUser(data, { newSession = false } = {}) {
    if (data) {
      markKnownRegisteredVisitor();
      setSessionEndedMessage("");
    }
    if (data && newSession) {
      // Only a fresh sign-in ends an eviction: reloading the user on a device
      // that is finishing its live class must keep the banner.
      setSessionEviction(null);
    }
    userIdRef.current = data?.id ?? null;
    setCapabilities(data?.capabilities ?? null);
    setUser(data);
  }

  function clearUser() {
    userIdRef.current = null;
    setCapabilities(null);
    setUser(null);
  }

  async function refreshUser() {
    try {
      const response = await fetchCurrentUser();
      setAuthenticatedUser(apiData(response));
    } catch {
      clearUser();
    } finally {
      setLoading(false);
    }
  }

  async function refreshAuthConfig() {
    try {
      const response = await fetchAuthConfig();
      const data = apiData(response, {});
      setWebPushEnabled(Boolean(data?.web_push_enabled));
      setWebPushPublicKey(String(data?.web_push_public_key || ""));
      const runtimeTurnstileSiteKey = String(data?.turnstile_site_key || "").trim();
      const resolvedTurnstileSiteKey = runtimeTurnstileSiteKey || buildTimeTurnstileSiteKey;
      setTurnstileEnabled(Boolean(data?.turnstile_enabled && resolvedTurnstileSiteKey));
      setTurnstileSiteKey(resolvedTurnstileSiteKey);
    } catch {
      setWebPushEnabled(false);
      setWebPushPublicKey("");
      setTurnstileEnabled(Boolean(buildTimeTurnstileSiteKey));
      setTurnstileSiteKey(buildTimeTurnstileSiteKey);
    }
  }

  async function refreshCsrf() {
    try {
      await fetchCsrfToken();
    } catch {
      // Ignore here; unsafe requests will surface actionable errors if bootstrap fails.
    }
  }

  useEffect(() => {
    if (hasBootstrappedRef.current) {
      return;
    }
    hasBootstrappedRef.current = true;
    refreshCsrf();
    refreshUser();
    refreshAuthConfig();
  }, []);

  useEffect(() => {
    const handleSessionExpired = (event) => {
      if (isSessionEviction(event?.detail)) {
        // Keep the user and the page mounted (a class may be playing); the
        // banner or dialog lets the student decide when to leave it.
        const next = {
          mode: isLiveGraceEviction(event.detail) ? "live" : "final",
          classEnded: isLiveClassEndedEviction(event.detail),
        };
        setSessionEviction((current) => (current?.mode === "final" && next.mode === "live" ? current : next));
        return;
      }
      // Same as clearUser(), with only stable setters and refs (no effect deps).
      userIdRef.current = null;
      capabilitiesJsonRef.current = "null";
      setCapabilitiesState(null);
      setUser(null);
      setLoading(false);
    };

    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, []);

  const signedInUserId = user?.id ?? null;
  useEffect(() => {
    if (signedInUserId == null || typeof window === "undefined") {
      return undefined;
    }
    const refresh = () => {
      refreshCapabilities();
    };
    const doc = typeof document === "undefined" ? null : document;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") {
        refresh();
      }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(CAPABILITIES_STALE_EVENT, refresh);
    doc?.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(refresh, CAPABILITIES_POLL_MS);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(CAPABILITIES_STALE_EVENT, refresh);
      doc?.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [signedInUserId, refreshCapabilities]);

  const login = async (payload) => {
    const response = await loginUser(payload);
    const data = apiData(response);
    setAuthenticatedUser(data, { newSession: true });
    return data;
  };

  const logout = async () => {
    try {
      await logoutUser();
    } finally {
      resetSessionEviction();
      setSessionEviction(null);
      clearUser();
    }
  };

  const signInOnThisDevice = () => {
    setSessionEndedMessage(SESSION_EVICTED_LOGIN_MESSAGE);
    setSessionEviction(null);
    clearUser();
  };

  const acceptTerms = async ({ accepted = true, terms_version } = {}) => {
    const response = await acceptTermsRequest({ accepted, terms_version });
    const data = apiData(response);
    setAuthenticatedUser(data);
    return data;
  };

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      isInstructor: user?.role === "instructor",
      isAdmin: Boolean(user?.is_admin),
      capabilities,
      refreshCapabilities,
      webPushEnabled,
      webPushPublicKey,
      turnstileEnabled,
      turnstileSiteKey,
      sessionEndedMessage,
      login,
      logout,
      acceptTerms,
      refreshUser,
      refreshAuthConfig,
      apiMessage,
    }),
    [
      user,
      loading,
      capabilities,
      refreshCapabilities,
      webPushEnabled,
      webPushPublicKey,
      turnstileEnabled,
      turnstileSiteKey,
      sessionEndedMessage,
    ]
  );

  // The dialog's state stays out of the context value so the routed page does
  // not even re-render when it opens.
  return (
    <AuthContext.Provider value={value}>
      {children}
      {sessionEviction ? (
        <SessionEvictionPrompt
          mode={sessionEviction.mode}
          classEnded={sessionEviction.classEnded}
          onUseThisDevice={signInOnThisDevice}
          onSignOut={logout}
        />
      ) : null}
    </AuthContext.Provider>
  );
}
