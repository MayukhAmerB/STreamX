import { describe, expect, it } from "vitest";

import {
  normalizeThemePreference,
  readStoredThemePreference,
  resolveCarbonTheme,
  THEME_STORAGE_KEY,
  writeStoredThemePreference,
} from "./theme";

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
  };
}

const blockedStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("app theme", () => {
  it("resolves preferences to Carbon White / G100", () => {
    expect(resolveCarbonTheme("light", true)).toBe("white");
    expect(resolveCarbonTheme("dark", false)).toBe("g100");
    expect(resolveCarbonTheme("system", true)).toBe("g100");
    expect(resolveCarbonTheme("system", false)).toBe("white");
    expect(resolveCarbonTheme("purple", true)).toBe("g100");
  });

  it("normalises and persists the preference safely", () => {
    expect(normalizeThemePreference("nope")).toBe("system");
    const storage = memoryStorage();
    expect(readStoredThemePreference(storage)).toBe("system");
    writeStoredThemePreference(storage, "dark");
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredThemePreference(storage)).toBe("dark");
    expect(readStoredThemePreference(blockedStorage)).toBe("system");
    expect(() => writeStoredThemePreference(blockedStorage, "light")).not.toThrow();
  });
});
