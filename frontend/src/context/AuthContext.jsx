import { createContext, useEffect, useMemo, useState } from "react";
import {
  fetchAuthConfig,
  fetchCsrfToken,
  fetchCurrentUser,
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
    } catch {
      setRegistrationEnabled(false);
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
    refreshCsrf();
    refreshUser();
    refreshAuthConfig();
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

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      isInstructor: user?.role === "instructor",
      isAdmin: Boolean(user?.is_admin),
      registrationEnabled,
      login,
      register,
      googleLogin,
      logout,
      refreshUser,
      refreshAuthConfig,
      apiMessage,
    }),
    [user, loading, registrationEnabled]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
