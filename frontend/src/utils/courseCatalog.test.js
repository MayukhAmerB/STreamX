import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterCoursesByCategory,
  getCourseCategoryCounts,
  readCachedCourseCatalog,
  writeCachedCourseCatalog,
} from "./courseCatalog";

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

describe("course catalog categories", () => {
  const courses = [
    { id: 1, category: "osint", title: "OSINT Foundations" },
    { id: 2, category: "web_pentesting", title: "Web Pentesting" },
    { id: 3, category: "osint", title: "Advanced OSINT" },
    { id: 4, category: "other", title: "Other" },
  ];

  it("returns every course in the selected category without mixing tracks", () => {
    expect(filterCoursesByCategory(courses, "osint").map((course) => course.id)).toEqual([1, 3]);
    expect(filterCoursesByCategory(courses, "web_pentesting").map((course) => course.id)).toEqual([
      2,
    ]);
  });

  it("reports category counts from backend course data", () => {
    expect(getCourseCategoryCounts(courses)).toEqual({
      osint: 2,
      web_pentesting: 1,
    });
  });

  it("shows no catalog until a valid category is selected", () => {
    expect(filterCoursesByCategory(courses, "")).toEqual([]);
    expect(filterCoursesByCategory(courses, "invalid")).toEqual([]);
  });
});
