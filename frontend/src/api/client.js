import axios from "axios";
import { resolveApiBaseUrl } from "../utils/backendUrl";

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
  baseURL: resolveApiBaseUrl(),
  withCredentials: true,
  withXSRFToken: true,
  xsrfCookieName: "csrftoken",
  xsrfHeaderName: "X-CSRFToken",
});

const csrfBootstrapClient = axios.create({
  baseURL: resolveApiBaseUrl(),
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

const REFRESH_RETRY_DELAYS_MS = [1000, 3000];
let refreshInFlight = null;
let lastRefreshCompletedAt = 0;

function isTransientFailure(error) {
  const status = error?.response?.status;
  return !status || status === 408 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestTokenRefresh() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiClient.post("/auth/refresh/");
    } catch (error) {
      if (!isTransientFailure(error) || attempt >= REFRESH_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = REFRESH_RETRY_DELAYS_MS[attempt];
      await wait(delayMs + Math.round(Math.random() * delayMs * 0.5));
    }
  }
}

// Concurrent 401s share one refresh, and a request that was already in flight
// when a refresh finished just retries with the new cookies.
function refreshSession(requestSentAt = 0) {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  if (requestSentAt && requestSentAt < lastRefreshCompletedAt) {
    return Promise.resolve();
  }
  refreshInFlight = requestTokenRefresh()
    .then((response) => {
      lastRefreshCompletedAt = Date.now();
      return response;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

apiClient.interceptors.request.use(async (config) => {
  config._sentAt = Date.now();
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
        await refreshSession(error.config._sentAt);
        return apiClient(error.config);
      } catch (refreshError) {
        // Only the server rejecting the session ends it; outages and throttling
        // must not log users out of a live class.
        if (!isTransientFailure(refreshError)) {
          const errors = refreshError?.response?.data?.errors || {};
          notifySessionExpired({
            code: errors.code || "",
            detail: errors.detail || refreshError?.response?.data?.detail || "Your session is no longer active.",
          });
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
