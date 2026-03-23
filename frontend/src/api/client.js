import axios from "axios";

const unsafeMethods = new Set(["post", "put", "patch", "delete"]);
let csrfTokenCache = "";
let csrfBootstrapPromise = null;

export const AUTH_SESSION_EXPIRED_EVENT = "auth:session-expired";

function notifySessionExpired(detail = {}) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_EXPIRED_EVENT, { detail }));
}

function extractCsrfToken(response) {
  const headerToken = response?.headers?.["x-csrftoken"];
  const bodyToken = response?.data?.csrf_token;
  const nestedBodyToken = response?.data?.data?.csrf_token;
  const token = String(headerToken || bodyToken || nestedBodyToken || "").trim();
  if (token) {
    csrfTokenCache = token;
  }
  return token;
}

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  withCredentials: true,
  withXSRFToken: true,
  xsrfCookieName: "csrftoken",
  xsrfHeaderName: "X-CSRFToken",
});

const csrfBootstrapClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  withCredentials: true,
});

async function ensureCsrfToken(forceRefresh = false) {
  if (!forceRefresh && csrfTokenCache) {
    return csrfTokenCache;
  }
  if (!csrfBootstrapPromise) {
    csrfBootstrapPromise = csrfBootstrapClient
      .get("/auth/csrf/")
      .then((response) => extractCsrfToken(response))
      .catch(() => "")
      .finally(() => {
        csrfBootstrapPromise = null;
      });
  }
  return csrfBootstrapPromise;
}

apiClient.interceptors.request.use(async (config) => {
  const method = String(config?.method || "get").toLowerCase();
  if (!unsafeMethods.has(method)) {
    return config;
  }
  const token = csrfTokenCache || (await ensureCsrfToken());
  if (token) {
    config.headers = config.headers || {};
    if (!config.headers["X-CSRFToken"]) {
      config.headers["X-CSRFToken"] = token;
    }
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    extractCsrfToken(response);
    return response;
  },
  async (error) => {
    extractCsrfToken(error?.response);
    const requestUrl = error?.config?.url || "";
    const isRefreshRequest = requestUrl.includes("/auth/refresh/");
    const responseDetail =
      error?.response?.data?.errors?.detail ||
      error?.response?.data?.detail ||
      error?.response?.data?.message ||
      "";
    const isCsrfFailure =
      error?.response?.status === 403 &&
      /csrf/i.test(String(responseDetail || "")) &&
      error.config &&
      !error.config._csrfRetry;
    if (isCsrfFailure) {
      error.config._csrfRetry = true;
      const freshToken = await ensureCsrfToken(true);
      if (freshToken) {
        error.config.headers = error.config.headers || {};
        error.config.headers["X-CSRFToken"] = freshToken;
        return apiClient(error.config);
      }
    }
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
      } catch (refreshError) {
        notifySessionExpired({
          detail:
            refreshError?.response?.data?.errors?.detail ||
            refreshError?.response?.data?.detail ||
            "Your session is no longer active.",
        });
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
