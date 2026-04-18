import apiClient from "./client";

export const fetchAuthConfig = () => apiClient.get("/auth/config/");
export const fetchCsrfToken = () => apiClient.get("/auth/csrf/");
export const fetchTerms = () => apiClient.get("/auth/terms/");
export const acceptTerms = (payload) => apiClient.post("/auth/terms/accept/", payload);
export const registerUser = (payload) => apiClient.post("/auth/register/", payload);
export const loginUser = (payload) => apiClient.post("/auth/login/", payload);
export const logoutUser = () => apiClient.post("/auth/logout/");
export const fetchCurrentUser = () => apiClient.get("/auth/user/");
export const googleLoginUser = (payload) => apiClient.post("/auth/google/", payload);
export const requestPasswordReset = (payload) => apiClient.post("/auth/password-reset/", payload);
export const confirmPasswordReset = (payload) =>
  apiClient.post("/auth/password-reset-confirm/", payload);
export const sendContactMessage = (payload) => apiClient.post("/auth/contact/", payload);
export const fetchProfile = () => apiClient.get("/auth/profile/");
export const updateProfile = (payload) => apiClient.patch("/auth/profile/", payload);
export const changePassword = (payload) => apiClient.post("/auth/change-password/", payload);
export const setupTwoFactor = () => apiClient.post("/auth/2fa/setup/");
export const enableTwoFactor = (payload) => apiClient.post("/auth/2fa/enable/", payload);
export const disableTwoFactor = (payload) => apiClient.post("/auth/2fa/disable/", payload);
