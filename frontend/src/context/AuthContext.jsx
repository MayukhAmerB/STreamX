import { createContext, useEffect, useMemo, useRef, useState } from "react";
import { AUTH_SESSION_EXPIRED_EVENT } from "../api/client";
import {
  fetchAuthConfig,
  fetchCsrfToken,
  fetchCurrentUser,
  acceptTerms as acceptTermsRequest,
  googleLoginUser,
  loginUser,
  logoutUser,
  registerUser,
} from "../api/auth";
import { apiData, apiMessage } from "../utils/api";

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [googleLoginEnabled, setGoogleLoginEnabled] = useState(false);
  const [webPushEnabled, setWebPushEnabled] = useState(false);
  const [webPushPublicKey, setWebPushPublicKey] = useState("");
  const hasBootstrappedRef = useRef(false);

  async function refreshUser() {
    try {
      const response = await fetchCurrentUser();
      setUser(apiData(response));
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
      setRegistrationEnabled(Boolean(data?.registration_enabled));
      setGoogleLoginEnabled(Boolean(data?.google_login_enabled));
      setWebPushEnabled(Boolean(data?.web_push_enabled));
      setWebPushPublicKey(String(data?.web_push_public_key || ""));
    } catch {
      setRegistrationEnabled(false);
      setGoogleLoginEnabled(false);
      setWebPushEnabled(false);
      setWebPushPublicKey("");
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
    const handleSessionExpired = () => {
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
    setUser(data);
    return data;
  };

  const register = async (payload) => {
    const response = await registerUser(payload);
    const data = apiData(response);
    setUser(data);
    return data;
  };

  const googleLogin = async (credential) => {
    const response = await googleLoginUser({ credential });
    const data = apiData(response);
    setUser(data);
    return data;
  };

  const logout = async () => {
    try {
      await logoutUser();
    } finally {
      setUser(null);
    }
  };

  const acceptTerms = async ({ accepted = true, terms_version } = {}) => {
    const response = await acceptTermsRequest({ accepted, terms_version });
    const data = apiData(response);
    setUser(data);
    return data;
  };

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      isInstructor: user?.role === "instructor",
      isAdmin: Boolean(user?.is_admin),
      registrationEnabled,
      googleLoginEnabled,
      webPushEnabled,
      webPushPublicKey,
      login,
      register,
      googleLogin,
      logout,
      acceptTerms,
      refreshUser,
      refreshAuthConfig,
      apiMessage,
    }),
    [user, loading, registrationEnabled, googleLoginEnabled, webPushEnabled, webPushPublicKey]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
