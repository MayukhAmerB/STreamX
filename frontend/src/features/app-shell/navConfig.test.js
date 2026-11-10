import { describe, expect, it } from "vitest";

import {
  BOTTOM_NAV_LIMIT,
  getActiveNavItemId,
  getBottomNavItems,
  getCornerTileGroups,
  getLearnCourseId,
  getMoreItems,
  getNavItems,
  getNavSections,
  getShellDocumentTitle,
  getShellPageMode,
  getUserRoles,
  isMoreActive,
  isFlushPage,
  isNavItemActive,
  NAV_ITEMS,
  CARBON_NATIVE_PATHS,
  CONSOLE_PATH,
  CONSOLE_TITLE,
  isExternalNavItem,
  LABS_URL,
  LEGACY_CONSOLE_PATH,
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
      if (item.external) {
        expect(item.href).toMatch(/^https:\/\//);
        expect(item.to).toBeUndefined();
        expect(item.match).toBeUndefined();
      } else {
        expect(item.to.startsWith("/")).toBe(true);
      }
      expect(item.icon).toBeTruthy();
      // Every destination has a one-line hint for the hub tiles.
      expect(item.hint).toBeTruthy();
    }
  });

  it("gives students only the learning and account destinations", () => {
    expect(ids(getNavItems(student))).toEqual([
      "overview",
      "my-courses",
      "continue-learning",
      "live-classes",
      "reports",
      "guides",
      "osint-tools",
      "labs",
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
    expect(ids(bottom)).toEqual(["overview", "my-courses", "continue-learning", "live-classes"]);
    const more = getMoreItems(items);
    expect(ids(more)).toEqual(
      expect.arrayContaining(["guides", "osint-tools", "profile", "id-card", "control-center"])
    );
    expect(ids(more)).not.toContain("overview");
    expect(more.length + bottom.length).toBe(items.length);
    expect(isMoreActive(items, "/id-card")).toBe(true);
    // Profile moved to More (it is also in the header's account panel).
    expect(isMoreActive(items, "/profile")).toBe(true);
    expect(isMoreActive(items, "/console")).toBe(false);
  });

  it("makes the Console hub the first destination and the shell's home", () => {
    expect(CONSOLE_PATH).toBe("/console");
    expect(CONSOLE_TITLE).toBe("Console");
    expect(LEGACY_CONSOLE_PATH).toBe("/users-corner");
    for (const auth of [student, instructor, admin]) {
      const [first] = getNavItems(auth);
      expect(first).toMatchObject({ id: "overview", label: "Overview", to: "/console", bottomNav: true });
      expect(getNavSections(auth)[0].items[0].id).toBe("overview");
    }
    const items = getNavItems(student);
    expect(getActiveNavItemId(items, "/console")).toBe("overview");
    expect(getActiveNavItemId(items, "/console/")).toBe("overview");
    expect(getActiveNavItemId(items, "/console-x")).toBe("");
    // The old address only redirects; it is not a shell page any more.
    expect(getActiveNavItemId(items, "/users-corner")).toBe("");
    expect(getShellPageMode("/console")).toBe("carbon");
    expect(isFlushPage("/console")).toBe(false);
  });

  it("titles browser tabs '<page> · Console'", () => {
    const items = getNavItems(instructor);
    expect(getShellDocumentTitle(items, "/console")).toBe("Console");
    expect(getShellDocumentTitle(items, "/my-courses")).toBe("My courses · Console");
    expect(getShellDocumentTitle(items, "/courses/3/live")).toBe("Live classes · Console");
    expect(getShellDocumentTitle(items, "/broadcasting?session=2")).toBe("Broadcasting · Console");
    expect(getShellDocumentTitle(items, "/somewhere-else")).toBe("Console");
    expect(getShellDocumentTitle(undefined, "/my-courses")).toBe("Console");
    expect(getShellDocumentTitle(null, "/my-courses")).toBe("Console");
  });

  it("adds Labs as an external learning link next to OSINT tools, Al syed only", () => {
    const items = getNavItems(student);
    const labs = items.find((item) => item.id === "labs");
    expect(LABS_URL).toBe("https://labs.alsyedinitiative.com");
    expect(labs).toMatchObject({ label: "Labs", section: "learn", href: LABS_URL, external: true });
    expect(isExternalNavItem(labs)).toBe(true);
    expect(isExternalNavItem(items[0])).toBe(false);
    expect(ids(items).indexOf("labs")).toBe(ids(items).indexOf("osint-tools") + 1);
    // Default brand is Al syed; OwlCognito has no lab, so no Labs anywhere.
    expect(ids(getNavItems(student, { brandId: "alsyed" }))).toContain("labs");
    for (const auth of [student, instructor, admin]) {
      expect(ids(getNavItems(auth, { brandId: "owlcognito" }))).not.toContain("labs");
      const tiles = getCornerTileGroups(auth, { brandId: "owlcognito" }).flatMap((group) => group.items);
      expect(ids(tiles)).not.toContain("labs");
    }
  });

  it("never treats the external Labs link as an internal route", () => {
    const items = getNavItems(student);
    const labs = items.find((item) => item.id === "labs");
    for (const path of ["/", "/console", "/labs", LABS_URL, "/osint-tools", ""]) {
      expect(isNavItemActive(labs, path)).toBe(false);
      expect(getActiveNavItemId(items, path)).not.toBe("labs");
    }
    // It lives in the More sheet on phones but never lights it up.
    expect(ids(getMoreItems(items))).toContain("labs");
    expect(ids(getBottomNavItems(items))).not.toContain("labs");
    expect(isMoreActive(items, "/labs")).toBe(false);
    expect(getShellDocumentTitle(items, "/labs")).toBe("Console");
    // Shell page modes only cover internal routes.
    expect(getShellPageMode("/labs")).toBe("legacy");
    expect(CARBON_NATIVE_PATHS.some((pattern) => pattern.test("/labs"))).toBe(false);
    expect(isFlushPage("/labs")).toBe(false);
  });

  it("builds the hub tiles from the same role rules as the nav", () => {
    const studentGroups = getCornerTileGroups(student);
    expect(studentGroups.map((group) => group.id)).toEqual(["corner"]);
    expect(ids(studentGroups[0].items)).toEqual([
      "my-courses",
      "live-classes",
      "reports",
      "guides",
      "osint-tools",
      "labs",
      "profile",
      "id-card",
    ]);
    const instructorGroups = getCornerTileGroups(instructor);
    expect(instructorGroups.map((group) => group.label)).toEqual(["Shortcuts", "Teaching"]);
    expect(ids(instructorGroups[1].items)).toEqual([
      "instructor-dashboard",
      "new-course",
      "report-grading",
      "control-center",
      "meeting",
      "broadcasting",
    ]);
    const adminTeaching = getCornerTileGroups(admin).find((group) => group.id === "teach");
    expect(ids(adminTeaching.items)).toEqual(["report-grading", "control-center", "meeting", "broadcasting", "lecture-questions"]);
    for (const group of [...studentGroups, ...instructorGroups]) {
      expect(ids(group.items)).not.toContain("overview");
      expect(ids(group.items)).not.toContain("continue-learning");
    }
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
      ["/report-grading", "report-grading", ["instructor", "admin"]],
      ["/report-grading/queue?task=3&submission=9", "report-grading", ["instructor", "admin"]],
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

  it("adds Reports for every student and Report grading for instructors and admins", () => {
    for (const auth of [student, instructor, admin]) {
      const items = getNavItems(auth);
      const reports = items.find((item) => item.id === "reports");
      expect(reports).toMatchObject({ section: "learn", to: "/reports", label: "Reports" });
      expect(ids(getBottomNavItems(items))).not.toContain("reports");
      expect(ids(getMoreItems(items))).toContain("reports");
      for (const path of ["/reports", "/reports/marks", "/reports/tasks/12"]) {
        expect(getActiveNavItemId(items, path)).toBe("reports");
        expect(getShellPageMode(path)).toBe("carbon");
        expect(isMoreActive(items, path)).toBe(true);
      }
      expect(getShellDocumentTitle(items, "/reports/tasks/3")).toBe("Reports · Console");
    }
    expect(ids(getNavItems(student))).not.toContain("report-grading");
    for (const path of ["/report-grading", "/report-grading/tasks/new", "/report-grading/gradebook?course=2"]) {
      expect(getShellPageMode(path)).toBe("carbon");
      expect(isFlushPage(path)).toBe(false);
    }
    expect(getActiveNavItemId(getNavItems(student), "/reportsx")).toBe("");
  });
});
