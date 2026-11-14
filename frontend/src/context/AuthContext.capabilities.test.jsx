import { useContext } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import capabilities from "../__contracts__/ui-overhaul/capabilities.json";
import { act, renderTree } from "../test-utils/renderTree";

globalThis.window = globalThis.window || new EventTarget();

const calls = { capabilities: 0, next: null };

vi.mock("../api/auth", () => ({
  fetchAuthConfig: () => Promise.resolve({ data: { data: {} } }),
  fetchCsrfToken: () => Promise.resolve({}),
  fetchCurrentUser: () =>
    Promise.resolve({ data: { data: { id: 2, role: "instructor", is_admin: false, capabilities: capabilities.instructor_off } } }),
  acceptTerms: vi.fn(),
  loginUser: vi.fn(),
  logoutUser: () => Promise.resolve({}),
}));

vi.mock("../features/capabilities/api", () => ({
  CAPABILITIES_STALE_EVENT: "capabilities:stale",
  CAPABILITIES_POLL_MS: 300000,
  fetchCapabilities: () => {
    calls.capabilities += 1;
    return Promise.resolve({ data: { data: calls.next } });
  },
}));

vi.mock("../services/realtime/liveClassGuard", () => ({ useLiveClassActive: () => false }));

const { AuthContext, AuthProvider } = await import("./AuthContext");

let latest = null;
function Probe() {
  latest = useContext(AuthContext);
  const state = latest?.capabilities?.workspaces?.teach?.state || "none";
  return `teach:${state}`;
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("AuthContext capabilities", { timeout: 30000 }, () => {
  let view;

  beforeAll(async () => {
    view = await renderTree(
      <MemoryRouter>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );
    await settle();
  });

  afterAll(async () => {
    await view?.unmount();
  });

  it("starts from the capabilities embedded in the user (no extra request)", () => {
    expect(view.text()).toBe("teach:disabled");
    expect(calls.capabilities).toBe(0);
  });

  it("refetches when an API answers feature_disabled (capabilities:stale)", async () => {
    calls.next = capabilities.instructor_on;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("capabilities:stale", { detail: { feature: "teaching" } }));
    });
    await settle();
    expect(calls.capabilities).toBe(1);
    expect(view.text()).toBe("teach:enabled");
  });

  it("refetches on window focus", async () => {
    calls.next = capabilities.instructor_off;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(calls.capabilities).toBe(2);
    expect(view.text()).toBe("teach:disabled");
  });

  it("keeps the last state when the refetch fails or returns nothing", async () => {
    calls.next = null;
    await act(async () => {
      await latest.refreshCapabilities();
    });
    await settle();
    expect(view.text()).toBe("teach:disabled");
  });
});
