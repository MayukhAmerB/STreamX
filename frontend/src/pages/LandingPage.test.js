import { describe, expect, it } from "vitest";

import { reserveGuestEnrollmentPrompt } from "./LandingPage";

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

describe("landing guest enrollment prompt", () => {
  it("reserves the prompt once per guest browsing session", () => {
    const storage = createStorage();
    const getStorage = () => storage;

    expect(
      reserveGuestEnrollmentPrompt({ authLoading: false, isAuthenticated: false, getStorage })
    ).toBe(true);
    expect(
      reserveGuestEnrollmentPrompt({ authLoading: false, isAuthenticated: false, getStorage })
    ).toBe(false);
  });

  it("does not reserve the prompt while auth is loading or for authenticated users", () => {
    const storage = createStorage();
    const getStorage = () => storage;

    expect(
      reserveGuestEnrollmentPrompt({ authLoading: true, isAuthenticated: false, getStorage })
    ).toBe(false);
    expect(
      reserveGuestEnrollmentPrompt({ authLoading: false, isAuthenticated: true, getStorage })
    ).toBe(false);
    expect(
      reserveGuestEnrollmentPrompt({ authLoading: false, isAuthenticated: false, getStorage })
    ).toBe(true);
  });

  it("still opens the prompt when browser session storage is unavailable", () => {
    expect(
      reserveGuestEnrollmentPrompt({
        authLoading: false,
        isAuthenticated: false,
        getStorage: () => {
          throw new Error("storage unavailable");
        },
      })
    ).toBe(true);
  });
});
