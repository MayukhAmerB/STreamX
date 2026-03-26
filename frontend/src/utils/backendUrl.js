function resolveConfiguredApiBaseUrl() {
  return String(import.meta.env.VITE_API_BASE_URL || "/api").trim();
}

function resolveConfiguredBackendOrigin() {
  const configured = String(import.meta.env.VITE_BACKEND_ORIGIN || "").trim();
  if (!configured) {
    return "";
  }

  if (/^https?:\/\//i.test(configured)) {
    try {
      return new URL(configured).origin;
    } catch {
      return "";
    }
  }

  if (configured.startsWith("//")) {
    if (typeof window === "undefined") {
      return "";
    }
    try {
      return new URL(`${window.location.protocol}${configured}`).origin;
    } catch {
      return "";
    }
  }

  return "";
}

export function resolveBackendOrigin() {
  const configuredBackendOrigin = resolveConfiguredBackendOrigin();
  if (configuredBackendOrigin) {
    return configuredBackendOrigin;
  }

  const apiBaseUrl = resolveConfiguredApiBaseUrl();

  if (/^https?:\/\//i.test(apiBaseUrl)) {
    try {
      return new URL(apiBaseUrl).origin;
    } catch {
      // Fall through to same-origin fallback.
    }
  }

  if (apiBaseUrl.startsWith("//") && typeof window !== "undefined") {
    try {
      return new URL(`${window.location.protocol}${apiBaseUrl}`).origin;
    } catch {
      // Fall through to same-origin fallback.
    }
  }

  if (typeof window !== "undefined" && window.location?.origin) {
    const host = String(window.location.hostname || "").trim().toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8000";
    }
    if (host && !host.startsWith("api.") && host.includes(".")) {
      const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;
      return `${window.location.protocol}//api.${normalizedHost}`;
    }
    return window.location.origin;
  }

  return "";
}

export function resolveApiBaseUrl() {
  const configuredApiBaseUrl = resolveConfiguredApiBaseUrl();
  if (!configuredApiBaseUrl) {
    return "/api";
  }

  if (/^https?:\/\//i.test(configuredApiBaseUrl)) {
    return configuredApiBaseUrl.replace(/\/+$/, "");
  }

  if (configuredApiBaseUrl.startsWith("//")) {
    if (typeof window === "undefined") {
      return configuredApiBaseUrl.replace(/\/+$/, "");
    }
    return `${window.location.protocol}${configuredApiBaseUrl}`.replace(/\/+$/, "");
  }

  const normalizedPath = configuredApiBaseUrl.startsWith("/")
    ? configuredApiBaseUrl
    : `/${configuredApiBaseUrl}`;

  if (typeof window !== "undefined" && window.location?.hostname) {
    const host = String(window.location.hostname || "").trim().toLowerCase();
    const isLocalhost = host === "localhost" || host === "127.0.0.1";
    if (!isLocalhost && host.includes(".")) {
      const backendOrigin = resolveBackendOrigin();
      if (backendOrigin) {
        return `${backendOrigin}${normalizedPath}`.replace(/\/+$/, "");
      }
    }
  }

  return normalizedPath.replace(/\/+$/, "");
}

export function resolveDjangoAdminUrl() {
  const backendOrigin = resolveBackendOrigin();
  if (!backendOrigin) {
    return "/admin/";
  }
  return `${backendOrigin}/admin/`;
}
