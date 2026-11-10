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
  isSessionEviction,
  loginReturnState,
} from "../utils/sessionEviction";
import SessionEvictedDialog from "../components/SessionEvictedDialog";

export const AuthContext = createContext(null);

const buildTimeTurnstileSiteKey = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || "").trim();

// Mounted only while the dialog is open, beside (never around) the routed page.
function SessionEvictionPrompt({ onUseThisDevice, onSignOut }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [signingOut, setSigningOut] = useState(false);

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

  return (
    <SessionEvictedDialog
      open
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
  const [sessionEvicted, setSessionEvicted] = useState(false);
  const hasBootstrappedRef = useRef(false);

  function setAuthenticatedUser(data) {
    if (data) {
      markKnownRegisteredVisitor();
      setSessionEndedMessage("");
      setSessionEvicted(false);
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
        // dialog lets the student decide when to leave it.
        setSessionEvicted(true);
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
    setAuthenticatedUser(data);
    return data;
  };

  const logout = async () => {
    try {
      await logoutUser();
    } finally {
      resetSessionEviction();
      setSessionEvicted(false);
      setUser(null);
    }
  };

  const signInOnThisDevice = () => {
    setSessionEndedMessage(SESSION_EVICTED_LOGIN_MESSAGE);
    setSessionEvicted(false);
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
      {sessionEvicted ? (
        <SessionEvictionPrompt onUseThisDevice={signInOnThisDevice} onSignOut={logout} />
      ) : null}
    </AuthContext.Provider>
  );
}
