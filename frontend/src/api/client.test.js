import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.window = globalThis.window || new EventTarget();
const { default: apiClient, AUTH_SESSION_EXPIRED_EVENT, resetSessionEviction } = await import("./client");

function failWith(config, status, data = {}) {
  const error = new Error(String(status));
  error.config = config;
  error.response = { status, data, headers: {}, config };
  throw error;
}

function installServer(handleRefresh) {
  const calls = { refresh: 0 };
  apiClient.defaults.adapter = async (config) => {
    const url = String(config.url);
    if (url.includes("/auth/csrf/")) {
      return { status: 200, data: {}, headers: { "x-csrftoken": "token" }, config };
    }
    if (url.includes("/auth/refresh/")) {
      calls.refresh += 1;
      return handleRefresh(config, calls.refresh);
    }
    if (config._retry) {
      return { status: 200, data: { ok: true }, headers: {}, config };
    }
    return failWith(config, 401);
  };
  return calls;
}

describe("api client session refresh", () => {
  let expiredEvents;
  const onExpired = (event) => expiredEvents.push(event.detail);

  beforeEach(() => {
    expiredEvents = [];
    resetSessionEviction();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  });

  afterEach(() => {
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
    vi.useRealTimers();
  });

  it("shares one refresh between concurrent 401s", async () => {
    const calls = installServer(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, data: {}, headers: {}, config };
    });

    const results = await Promise.allSettled([
      apiClient.get("/realtime/sessions/1/"),
      apiClient.get("/realtime/sessions/"),
      apiClient.get("/auth/user/"),
    ]);

    expect(calls.refresh).toBe(1);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(expiredEvents).toEqual([]);
  });

  it("keeps the session when refresh fails transiently", async () => {
    vi.useFakeTimers();
    const calls = installServer((config) => failWith(config, 503));

    const pending = apiClient.get("/realtime/sessions/1/").catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(error.response.status).toBe(401);
    expect(calls.refresh).toBe(3);
    expect(expiredEvents).toEqual([]);
  });

  it("ends the session when the server rejects the refresh token", async () => {
    installServer((config) =>
      failWith(config, 401, {
        errors: { code: "session_replaced", detail: "This account is active on another device." },
      })
    );

    await expect(apiClient.get("/realtime/sessions/1/")).rejects.toBeTruthy();

    expect(expiredEvents).toEqual([
      { code: "session_replaced", detail: "This account is active on another device." },
    ]);
  });

  describe("after another device takes the session", () => {
    const evicted = {
      errors: { code: "session_replaced", detail: "This account is active on another device." },
    };
    const originalLocation = globalThis.window.location;
    let location;

    beforeEach(() => {
      location = { href: "https://academy.test/learn/29", assign: vi.fn(), replace: vi.fn(), reload: vi.fn() };
      globalThis.window.location = location;
    });

    afterEach(() => {
      globalThis.window.location = originalLocation;
    });

    it("reports the eviction once for many concurrent 401s", async () => {
      const calls = installServer(async (config) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return failWith(config, 401, evicted);
      });

      const results = await Promise.allSettled([
        apiClient.get("/realtime/sessions/1/"),
        apiClient.get("/notifications/"),
        apiClient.get("/courses/29/progress/"),
      ]);

      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
      expect(calls.refresh).toBe(1);
      expect(expiredEvents).toEqual([evicted.errors]);
    });

    it("stops refreshing and never redirects or reloads the page", async () => {
      const calls = installServer((config) => failWith(config, 401, evicted));
      await expect(apiClient.get("/realtime/sessions/1/")).rejects.toBeTruthy();

      const later = await Promise.allSettled([
        apiClient.get("/realtime/sessions/1/"),
        apiClient.get("/notifications/"),
      ]);

      expect(later.map((result) => result.reason?.response?.status)).toEqual([401, 401]);
      expect(calls.refresh).toBe(1);
      expect(expiredEvents).toHaveLength(1);
      expect(location.href).toBe("https://academy.test/learn/29");
      expect(location.assign).not.toHaveBeenCalled();
      expect(location.replace).not.toHaveBeenCalled();
      expect(location.reload).not.toHaveBeenCalled();
    });

    it("refreshes again once this browser signs in again", async () => {
      const calls = installServer((config) => failWith(config, 401, evicted));
      await expect(apiClient.get("/realtime/sessions/1/")).rejects.toBeTruthy();

      await apiClient.get("/auth/csrf/");
      const serve = apiClient.defaults.adapter;
      apiClient.defaults.adapter = async (config) =>
        String(config.url).includes("/auth/login/")
          ? { status: 200, data: { success: true }, headers: {}, config }
          : serve(config);
      await apiClient.post("/auth/login/", { email: "student@test.com", password: "secret" });
      await expect(apiClient.get("/realtime/sessions/1/")).rejects.toBeTruthy();

      expect(calls.refresh).toBe(2);
      expect(expiredEvents).toHaveLength(2);
    });
  });
});
