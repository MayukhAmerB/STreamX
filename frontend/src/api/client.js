import axios from "axios";

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  withCredentials: true,
  withXSRFToken: true,
  xsrfCookieName: "csrftoken",
  xsrfHeaderName: "X-CSRFToken",
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const requestUrl = error?.config?.url || "";
    const isRefreshRequest = requestUrl.includes("/auth/refresh/");
    if (
      error?.response?.status === 401 &&
      error.config &&
      !error.config._retry &&
      !isRefreshRequest
    ) {
      error.config._retry = true;
      try {
        await apiClient.post("/auth/refresh/");
        return apiClient(error.config);
      } catch {
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
