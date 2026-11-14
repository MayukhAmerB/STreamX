import { createContext, useEffect, useMemo, useRef, useState } from "react";
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
    setUser(data);
  }

  async function refreshUser() {
    try {
      const response = await fetchCurrentUser();
      setAuthenticatedUser(apiData(response));
    } catch {
      setUser(null);
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
      setUser(null);
      setLoading(false);
    };

    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => {
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, handleSessionExpired);
    };
  }, []);

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
      setUser(null);
    }
  };

  const signInOnThisDevice = () => {
    setSessionEndedMessage(SESSION_EVICTED_LOGIN_MESSAGE);
    setSessionEviction(null);
    setUser(null);
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
