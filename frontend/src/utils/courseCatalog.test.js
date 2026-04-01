import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCachedCourseCatalog, writeCachedCourseCatalog } from "./courseCatalog";

function createLocalStorageMock() {
  let store = {};

  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    clear() {
      store = {};
    },
  };
}

describe("course catalog cache", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      localStorage: createLocalStorageMock(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips user-scoped enrollment fields before caching catalog data", () => {
    writeCachedCourseCatalog([
      {
        id: 11,
        title: "OSINT Professional Training Program",
        is_enrolled: true,
        enrollment_status: "approved",
        enrolled_at: "2026-04-01T10:00:00Z",
        access_source: "purchased",
        access_label: "Unlocked",
      },
    ]);

    const cachedCourses = readCachedCourseCatalog();

    expect(cachedCourses).toHaveLength(1);
    expect(cachedCourses[0]).toMatchObject({
      id: 11,
      title: "OSINT Professional Training Program",
    });
    expect(cachedCourses[0]).not.toHaveProperty("is_enrolled");
    expect(cachedCourses[0]).not.toHaveProperty("enrollment_status");
    expect(cachedCourses[0]).not.toHaveProperty("enrolled_at");
    expect(cachedCourses[0]).not.toHaveProperty("access_source");
    expect(cachedCourses[0]).not.toHaveProperty("access_label");
  });
});
