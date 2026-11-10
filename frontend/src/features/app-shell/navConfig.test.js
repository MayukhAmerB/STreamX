import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_LIMIT,
  getActiveNavItemId,
  getBottomNavItems,
  getLearnCourseId,
  getMoreItems,
  getNavItems,
  getNavSections,
  getShellPageMode,
  getUserRoles,
  isMoreActive,
  isFlushPage,
  isNavItemActive,
  NAV_ITEMS,
  resolveContinueLearningPath,
} from "./navConfig";

const student = { user: { role: "student" }, isInstructor: false, isAdmin: false };
const instructor = { user: { role: "instructor" }, isInstructor: true, isAdmin: false };
const admin = { user: { role: "student", is_admin: true }, isInstructor: false, isAdmin: true };

const ids = (items) => items.map((item) => item.id);

describe("nav config", () => {
  it("has unique ids and a label, short label, path and icon for every item", () => {
    expect(new Set(ids(NAV_ITEMS)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy();
      expect(item.shortLabel.length).toBeLessThanOrEqual(10);
      expect(item.to.startsWith("/")).toBe(true);
      expect(item.icon).toBeTruthy();
    }
  });

  it("gives students only the learning and account destinations", () => {
    expect(ids(getNavItems(student))).toEqual([
      "my-courses",
      "continue-learning",
      "live-classes",
      "guides",
      "osint-tools",
      "profile",
      "id-card",
    ]);
    expect(ids(getNavSections(student))).toEqual(["learn", "account"]);
  });

  it("adds instructor and moderator tools for instructors, but not admin-only items", () => {
    const items = ids(getNavItems(instructor));
    expect(items).toEqual(
      expect.arrayContaining(["instructor-dashboard", "new-course", "control-center", "meeting", "broadcasting"])
    );
    expect(items).not.toContain("lecture-questions");
    expect(ids(getNavSections(instructor))).toEqual(["learn", "account", "teach"]);
  });

  it("gives admins moderator tools and lecture questions but not instructor authoring", () => {
    const items = ids(getNavItems(admin));
    expect(items).toEqual(expect.arrayContaining(["control-center", "meeting", "broadcasting", "lecture-questions"]));
    expect(items).not.toContain("instructor-dashboard");
    expect(items).not.toContain("new-course");
  });

  it("derives roles from either auth flags or the raw user", () => {
    expect([...getUserRoles({ user: { role: "instructor" } })]).toEqual(["student", "instructor", "moderator"]);
    expect([...getUserRoles({ user: { is_admin: true } })]).toEqual(["student", "admin", "moderator"]);
    expect([...getUserRoles(undefined)]).toEqual(["student"]);
  });

  it("resolves Continue learning to the last opened course or the library", () => {
    expect(resolveContinueLearningPath("42")).toBe("/learn/42");
    expect(resolveContinueLearningPath("")).toBe("/my-courses");
    expect(resolveContinueLearningPath("../admin")).toBe("/my-courses");
    const continueItem = getNavItems(student, { lastCourseId: "7" }).find((item) => item.id === "continue-learning");
    expect(continueItem.to).toBe("/learn/7");
    expect(getLearnCourseId("/learn/12")).toBe("12");
    expect(getLearnCourseId("/learn/12/lesson")).toBe("12");
    expect(getLearnCourseId("/my-courses")).toBe("");
  });

  it("marks the right item active for nested and query-string routes", () => {
    const items = getNavItems(instructor);
    expect(getActiveNavItemId(items, "/my-courses")).toBe("my-courses");
    expect(getActiveNavItemId(items, "/learn/3")).toBe("continue-learning");
    expect(getActiveNavItemId(items, "/courses/3/live")).toBe("live-classes");
    expect(getActiveNavItemId(items, "/join-live?room=1")).toBe("live-classes");
    expect(getActiveNavItemId(items, "/instructor/courses/9/edit")).toBe("instructor-dashboard");
    expect(getActiveNavItemId(items, "/courses/3")).toBe("");
    expect(isNavItemActive(items[0], "/my-courses-extra")).toBe(false);
  });

  it("puts four primary destinations in the phone tab bar and the rest in More", () => {
    const items = getNavItems(instructor);
    const bottom = getBottomNavItems(items);
    expect(bottom).toHaveLength(BOTTOM_NAV_LIMIT);
    expect(ids(bottom)).toEqual(["my-courses", "continue-learning", "live-classes", "profile"]);
    const more = getMoreItems(items);
    expect(ids(more)).toEqual(expect.arrayContaining(["guides", "osint-tools", "id-card", "control-center"]));
    expect(ids(more)).not.toContain("profile");
    expect(more.length + bottom.length).toBe(items.length);
    expect(isMoreActive(items, "/id-card")).toBe(true);
    expect(isMoreActive(items, "/profile")).toBe(false);
  });

  it("knows which shell pages are already Carbon-native", () => {
    expect(getShellPageMode("/my-courses")).toBe("carbon");
    expect(getShellPageMode("/profile")).toBe("carbon");
    expect(getShellPageMode("/learn/4")).toBe("carbon");
    expect(getShellPageMode("/join-live")).toBe("carbon");
  });

  it("treats the phase 5 student pages as Carbon-native", () => {
    expect(getShellPageMode("/guides")).toBe("carbon");
    expect(getShellPageMode("/osint-tools/")).toBe("carbon");
    expect(getShellPageMode("/id-card?x=1")).toBe("carbon");
  });

  it("renders the student live pages Carbon-native and edge to edge", () => {
    for (const path of ["/join-live", "/join-live?session=3", "/courses/29/live", "/courses/29/live/"]) {
      expect(getShellPageMode(path)).toBe("carbon");
      expect(isFlushPage(path)).toBe(true);
    }
    expect(getShellPageMode("/courses/29")).toBe("legacy");
    expect(isFlushPage("/my-courses")).toBe(false);
  });

  it("keeps staff tools in the legacy frame inside the shell", () => {
    for (const path of [
      "/control-center",
      "/meeting",
      "/broadcasting?session=4",
      "/lecture-questions",
      "/instructor/dashboard",
      "/instructor/courses/new",
      "/instructor/courses/12/edit",
    ]) {
      expect(getShellPageMode(path)).toBe("legacy");
    }
  });

  it("gives every staff route a nav entry gated like its ProtectedRoute and highlights it", () => {
    // [path, nav item id, roles that ProtectedRoute lets in]
    const staffRoutes = [
      ["/control-center", "control-center", ["instructor", "admin"]], // requireModerator
      ["/meeting", "meeting", ["instructor", "admin"]],
      ["/broadcasting?session=4", "broadcasting", ["instructor", "admin"]],
      ["/lecture-questions", "lecture-questions", ["admin"]], // requireAdmin
      ["/instructor/dashboard", "instructor-dashboard", ["instructor"]], // requireInstructor
      ["/instructor/courses/new", "new-course", ["instructor"]],
      ["/instructor/courses/12/edit", "instructor-dashboard", ["instructor"]],
    ];
    const users = { student, instructor, admin };
    for (const [path, itemId, allowed] of staffRoutes) {
      for (const [name, auth] of Object.entries(users)) {
        const items = getNavItems(auth);
        const visible = ids(items).includes(itemId);
        expect(`${name} ${path} ${visible}`).toBe(`${name} ${path} ${allowed.includes(name)}`);
        if (visible) {
          expect(getActiveNavItemId(items, path)).toBe(itemId);
          // Teaching tools live in the More sheet on phones, which then shows as active.
          expect(isMoreActive(items, path)).toBe(true);
        }
      }
    }
  });
});
