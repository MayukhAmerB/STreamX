import { describe, expect, it } from "vitest";

import { readSideNavCollapsed, SIDE_NAV_STORAGE_KEY, writeSideNavCollapsed } from "./useSideNavCollapsed";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

const throwingStorage = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

describe("side nav rail preference", () => {
  it("remembers the collapsed rail per viewer and forgets it when expanded", () => {
    const storage = memoryStorage();
    expect(readSideNavCollapsed(storage)).toBe(false);
    writeSideNavCollapsed(true, storage);
    expect(storage.values.get(SIDE_NAV_STORAGE_KEY)).toBe("1");
    expect(readSideNavCollapsed(storage)).toBe(true);
    writeSideNavCollapsed(false, storage);
    expect(storage.values.has(SIDE_NAV_STORAGE_KEY)).toBe(false);
    expect(readSideNavCollapsed(storage)).toBe(false);
  });

  it("falls back to the full side nav when storage is missing or blocked", () => {
    expect(readSideNavCollapsed(null)).toBe(false);
    expect(readSideNavCollapsed(throwingStorage)).toBe(false);
    expect(() => writeSideNavCollapsed(true, throwingStorage)).not.toThrow();
    expect(() => writeSideNavCollapsed(true, null)).not.toThrow();
  });
});
