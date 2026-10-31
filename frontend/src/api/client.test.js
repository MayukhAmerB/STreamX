import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.window = globalThis.window || new EventTarget();
const { default: apiClient, AUTH_SESSION_EXPIRED_EVENT } = await import("./client");

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
});
