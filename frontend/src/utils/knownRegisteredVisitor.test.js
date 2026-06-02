import { describe, expect, it } from "vitest";

import { isKnownRegisteredVisitor, markKnownRegisteredVisitor } from "./knownRegisteredVisitor";

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

describe("known registered visitor marker", () => {
  it("remembers a browser after a successful authentication flow", () => {
    const storage = createStorage();
    const getStorage = () => storage;

    expect(isKnownRegisteredVisitor(getStorage)).toBe(false);
    markKnownRegisteredVisitor(getStorage);
    expect(isKnownRegisteredVisitor(getStorage)).toBe(true);
  });

  it("fails safely when browser storage is unavailable", () => {
    const getStorage = () => {
      throw new Error("storage unavailable");
    };

    expect(isKnownRegisteredVisitor(getStorage)).toBe(false);
    expect(() => markKnownRegisteredVisitor(getStorage)).not.toThrow();
  });
});
