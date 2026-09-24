import apiClient from "./client";

export const listSocialAccounts = () => apiClient.get("/as-accounts/");
