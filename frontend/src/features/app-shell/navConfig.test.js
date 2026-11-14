import { describe, expect, it } from "vitest";
import capabilities from "../../__contracts__/ui-overhaul/capabilities.json";
import {
  ADMIN_GROUPS,
  ADMIN_ITEMS,
  BOTTOM_NAV_LIMIT,
  buildShellNav,
  CHECKING_REASON,
  getBottomNavItems,
  getCornerTileGroups,
  getNavDestinations,
  getShellDocumentTitle,
  getShellPageMode,
  getUserRoles,
  getViewerKind,
  getWorkspaceForPath,
  getWorkspaceItems,
  getWorkspaceOptions,
  isFlushPage,
  isFocusPath,
  isNavItemActive,
  LEARN_ITEMS,
  ROLE_MODERATOR,
  TEACH_ITEMS,
  TEACHING_OFF_REASON,
} from "./navConfig";

const student = { user: { id: 1, role: "student" }, isInstructor: false, isAdmin: false };
const instructor = { user: { id: 2, role: "instructor" }, isInstructor: true, isAdmin: false };
const staff = { user: { id: 3, role: "student", is_admin: true }, isInstructor: false, isAdmin: true };
const staffInstructor = { user: { id: 4, role: "instructor", is_admin: true }, isInstructor: true, isAdmin: true };

const ids = (items) => items.map((item) => item.id);

describe("viewer kinds", () => {
  it("treats staff as staff even when their role is instructor", () => {
    expect(getViewerKind(student)).toBe("student");
    expect(getViewerKind(instructor)).toBe("instructor");
    expect(getViewerKind(staff)).toBe("staff");
    expect(getViewerKind(staffInstructor)).toBe("staff");
  });

  it("keeps the role set used by pages (moderator = instructor or staff)", () => {
    expect(getUserRoles(student).has(ROLE_MODERATOR)).toBe(false);
    expect(getUserRoles(instructor).has(ROLE_MODERATOR)).toBe(true);
    expect(getUserRoles(staff).has(ROLE_MODERATOR)).toBe(true);
  });
});

describe("workspace switch per role × capabilities", () => {
  it("shows no switch to students", () => {
    expect(getWorkspaceOptions(student, capabilities.student)).toEqual([]);
  });

  it("shows Learn | Teach (disabled with the reason) to instructors while teaching is off", () => {
    const options = getWorkspaceOptions(instructor, capabilities.instructor_off);
    expect(options.map((option) => [option.key, option.state])).toEqual([
      ["learn", "enabled"],
      ["teach", "disabled"],
    ]);
    expect(options[1].reason).toBe(TEACHING_OFF_REASON);
  });

  it("keeps Teach disabled with 'Checking…' until capabilities load (never flashes enabled)", () => {
    const [, teach] = getWorkspaceOptions(instructor, null);
    expect(teach).toMatchObject({ key: "teach", state: "disabled", reason: CHECKING_REASON });
  });

  it("enables Teach when teaching is on", () => {
    expect(getWorkspaceOptions(instructor, capabilities.instructor_on).map((option) => option.state)).toEqual(["enabled", "enabled"]);
  });

  it("shows Learn | Admin to staff whatever the switch says (never Teach)", () => {
    for (const caps of [capabilities.staff_off, capabilities.staff_on, null]) {
      expect(getWorkspaceOptions(staff, caps).map((option) => `${option.key}:${option.state}`)).toEqual(["learn:enabled", "admin:enabled"]);
    }
  });
});

describe("workspace items", () => {
  it("gives everyone the same Learn workspace (≤ 7 items, no duplicates, no Account group)", () => {
    for (const viewer of [student, instructor, staff]) {
      const items = getWorkspaceItems("learn", viewer);
      expect(ids(items)).toEqual(["home", "courses", "live", "coursework", "guides", "osint-tools", "labs"]);
      expect(items.length).toBeLessThanOrEqual(7);
      expect(new Set(ids(items)).size).toBe(items.length);
    }
  });

  it("adds Achievements and Leaderboard (Progress) only while the engagement switch is on", () => {
    const on = { features: { engagement: { enabled: true } } };
    const items = getWorkspaceItems("learn", student, { caps: on });
    expect(ids(items)).toEqual(["home", "courses", "live", "coursework", "guides", "osint-tools", "labs", "achievements", "leaderboard"]);
    expect(items.find((item) => item.id === "achievements")).toMatchObject({ to: "/achievements", section: "progress", state: "enabled" });
    expect(ids(getWorkspaceItems("learn", student, { caps: { features: { engagement: { enabled: false } } } }))).not.toContain("leaderboard");
    expect(getShellPageMode("/achievements")).toBe("carbon");
    expect(getShellPageMode("/leaderboard")).toBe("carbon");
  });

  it("adds Public profile (Progress) only while the public_profiles switch is on", () => {
    const on = { features: { public_profiles: { enabled: true } } };
    const item = getWorkspaceItems("learn", student, { caps: on }).find((row) => row.id === "public-profile");
    expect(item).toMatchObject({ to: "/profile/public", section: "progress", state: "enabled" });
    expect(ids(getWorkspaceItems("learn", student, { caps: { features: {} } }))).not.toContain("public-profile");
    expect(ids(getWorkspaceItems("learn", student, {}))).not.toContain("public-profile");
  });

  it("labels the Labs row Free while the labs are open and Members once membership is required", () => {
    const labs = (caps) => getWorkspaceItems("learn", student, { caps }).find((item) => item.id === "labs");
    expect(labs(null).chip).toBe("Free");
    expect(labs({ features: { labs_membership_required: { enabled: false } } }).chip).toBe("Free");
    expect(labs({ features: { labs_membership_required: { enabled: true } } }).chip).toBe("Members");
  });

  it("drops brand-only Labs for other brands and Guides while there are none", () => {
    expect(ids(getWorkspaceItems("learn", student, { brandId: "owlcognito" }))).not.toContain("labs");
    expect(ids(getWorkspaceItems("learn", student, { guidesAvailable: false }))).not.toContain("guides");
  });

  it("removes the old duplicates (Continue learning, Account, Control center, My marks)", () => {
    const all = [...LEARN_ITEMS, ...TEACH_ITEMS, ...ADMIN_ITEMS].map((item) => item.label);
    for (const gone of ["Continue learning", "Control center", "My marks", "Overview", "Report grading", "Broadcasting", "Meeting room"]) {
      expect(all).not.toContain(gone);
    }
  });

  it("gives instructors Today, Courses, Classes, Recordings, Grading, Exams when teaching is on", () => {
    const items = getWorkspaceItems("teach", instructor, { caps: capabilities.instructor_on });
    expect(items.map((item) => item.label)).toEqual(["Today", "Courses", "Classes", "Recordings", "Grading", "Exams"]);
    expect(items.every((item) => item.state === "enabled")).toBe(true);
  });

  it("marks every Teach item disabled with the reason while teaching is off", () => {
    const items = getWorkspaceItems("teach", instructor, { caps: capabilities.instructor_off });
    expect(items.every((item) => item.state === "disabled" && item.reason === TEACHING_OFF_REASON)).toBe(true);
  });

  it("never gives students or staff Teach items", () => {
    expect(getWorkspaceItems("teach", student, { caps: capabilities.student })).toEqual([]);
    expect(getWorkspaceItems("teach", staff, { caps: capabilities.staff_on })).toEqual([]);
  });

  it("gives staff the 8 admin groups (same as the back office), never gated", () => {
    const items = getWorkspaceItems("admin", staff, { caps: capabilities.staff_off });
    expect(new Set(items.map((item) => item.section))).toEqual(new Set(ADMIN_GROUPS.map((group) => group.id)));
    expect(ADMIN_GROUPS.map((group) => group.label)).toEqual([
      "Today",
      "Live classes",
      "Content",
      "Students & sales",
      "Assessments",
      "Community",
      "Settings",
      "System",
    ]);
    expect(items.every((item) => item.state === "enabled")).toBe(true);
    expect(getWorkspaceItems("admin", instructor)).toEqual([]);
    // Each group is small enough that the open group plus every header fits 1440×768.
    for (const group of ADMIN_GROUPS) {
      expect(items.filter((item) => item.section === group.id).length).toBeLessThanOrEqual(5);
    }
  });

  it("points wave-2 admin items at their back-office page (new tab)", () => {
    const items = getWorkspaceItems("admin", staff, { backOfficeUrl: "https://api.example.com/admin/" });
    const payments = items.find((item) => item.id === "admin-payments");
    expect(payments).toMatchObject({ external: true, href: "https://api.example.com/admin/payments/payment/" });
    expect(items.find((item) => item.id === "admin-back-office").href).toBe("https://api.example.com/admin/");
    expect(items.find((item) => item.id === "admin-requests").to).toBe("/console/admin/requests");
  });
});

describe("phone tab bars", () => {
  it("Learn: Home · Courses · Live · Work (+ More)", () => {
    const bottom = getBottomNavItems(getWorkspaceItems("learn", student), "learn");
    expect(bottom.map((item) => item.shortLabel)).toEqual(["Home", "Courses", "Live", "Work"]);
    expect(bottom.length).toBeLessThanOrEqual(BOTTOM_NAV_LIMIT);
  });

  it("Teach: Today · Grading · Classes · Recordings (+ More)", () => {
    const bottom = getBottomNavItems(getWorkspaceItems("teach", instructor, { caps: capabilities.instructor_on }), "teach");
    expect(bottom.map((item) => item.shortLabel)).toEqual(["Today", "Grading", "Classes", "Recordings"]);
  });

  it("Admin: Home · Live · Grading · Search (+ More); Search opens the palette", () => {
    const bottom = getBottomNavItems(getWorkspaceItems("admin", staff), "admin");
    expect(bottom.map((item) => item.shortLabel)).toEqual(["Home", "Live", "Grading", "Search"]);
    expect(bottom[3]).toMatchObject({ action: "palette" });
  });
});

describe("which workspace a path belongs to", () => {
  it.each([
    ["/console", staff, "learn"],
    ["/my-courses", staff, "learn"],
    ["/console/admin", staff, "admin"],
    ["/console/admin/grading/queue", staff, "admin"],
    ["/console/teach/grading", staff, "admin"],
    ["/report-grading/queue", staff, "admin"],
    ["/broadcasting", staff, "admin"],
    ["/console/admin", student, "learn"],
    ["/report-grading", student, "learn"],
  ])("%s for %o is %s", (path, viewer, workspace) => {
    expect(getWorkspaceForPath(path, viewer, capabilities.staff_off)).toBe(workspace);
  });

  it("puts instructors in Teach only while teaching is on", () => {
    expect(getWorkspaceForPath("/console/teach", instructor, capabilities.instructor_on)).toBe("teach");
    expect(getWorkspaceForPath("/report-grading", instructor, capabilities.instructor_on)).toBe("teach");
    expect(getWorkspaceForPath("/console/teach", instructor, capabilities.instructor_off)).toBe("learn");
    expect(getWorkspaceForPath("/report-grading", instructor, capabilities.instructor_off)).toBe("learn");
  });
});

describe("buildShellNav", () => {
  it("highlights the right row, also for old URLs and deeper pages", () => {
    expect(buildShellNav(student, { pathname: "/learn/12" }).activeItem.id).toBe("courses");
    expect(buildShellNav(student, { pathname: "/reports/tasks/88" }).activeItem.id).toBe("coursework");
    expect(buildShellNav(student, { pathname: "/gradebook" }).activeItem.id).toBe("coursework");
    expect(buildShellNav(student, { pathname: "/courses/4/live" }).activeItem.id).toBe("live");
    expect(buildShellNav(staff, { pathname: "/report-grading/queue", caps: capabilities.staff_off }).activeItem.id).toBe("admin-grading");
    expect(buildShellNav(staff, { pathname: "/console/admin/community", caps: capabilities.staff_off }).activeItem.id).toBe("admin-questions");
    expect(buildShellNav(staff, { pathname: "/console/admin/recordings/upload" }).activeItem.id).toBe("admin-upload");
    expect(buildShellNav(staff, { pathname: "/console/admin/classes/5/studio" }).activeItem.id).toBe("admin-classes");
    expect(buildShellNav(student, { pathname: "/profile" }).activeItem.id).toBe("profile");
  });

  it("builds breadcrumbs: none on Learn home, workspace / item elsewhere", () => {
    expect(buildShellNav(student, { pathname: "/console" }).breadcrumbs).toEqual([]);
    expect(buildShellNav(student, { pathname: "/reports" }).breadcrumbs).toEqual([{ label: "Coursework", to: null }]);
    expect(buildShellNav(student, { pathname: "/learn/12" }).breadcrumbs).toEqual([{ label: "Courses", to: "/my-courses" }]);
    expect(buildShellNav(staff, { pathname: "/console/admin" }).breadcrumbs).toEqual([{ label: "Admin", to: null }]);
    expect(buildShellNav(staff, { pathname: "/console/admin/grading" }).breadcrumbs).toEqual([
      { label: "Admin", to: "/console/admin" },
      { label: "Grading", to: null },
    ]);
  });

  it("marks deeper pages as non-root with a way back to their section", () => {
    const deep = buildShellNav(student, { pathname: "/reports/tasks/88" });
    expect(deep).toMatchObject({ isRoot: false, backTo: "/reports", backLabel: "Coursework", title: "Coursework" });
    expect(buildShellNav(student, { pathname: "/my-courses" }).isRoot).toBe(true);
    expect(buildShellNav(staff, { pathname: "/console/admin" }).isRoot).toBe(true);
  });

  it("switches on focus mode for the player, the live room and the host studio", () => {
    expect(isFocusPath("/learn/12")).toBe(true);
    expect(isFocusPath("/courses/3/live")).toBe(true);
    expect(isFocusPath("/console/admin/classes/5/studio")).toBe(true);
    expect(isFocusPath("/console/teach/classes/5/studio")).toBe(true);
    expect(isFocusPath("/join-live")).toBe(false);
    expect(buildShellNav(student, { pathname: "/learn/12" }).focus).toBe(true);
  });

  it("puts what is not on the tab bar in the More sheet, with no duplicates", () => {
    const nav = buildShellNav(student, { pathname: "/console" });
    expect(ids(nav.moreItems)).toEqual(["guides", "osint-tools", "labs"]);
    const all = [...ids(nav.bottomItems), ...ids(nav.moreItems)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("never shows a 'Console' eyebrow: titles are '<page> · Console'", () => {
    expect(getShellDocumentTitle(buildShellNav(student, { pathname: "/console" }))).toBe("Console");
    expect(getShellDocumentTitle(buildShellNav(student, { pathname: "/reports" }))).toBe("Coursework · Console");
    expect(getShellDocumentTitle(buildShellNav(staff, { pathname: "/console/admin" }))).toBe("Admin · Console");
  });
});

describe("isNavItemActive", () => {
  it("never marks external or action items active", () => {
    const labs = LEARN_ITEMS.find((item) => item.id === "labs");
    expect(isNavItemActive(labs, "/console")).toBe(false);
    expect(isNavItemActive({ action: "palette" }, "/console")).toBe(false);
  });
});

describe("palette destinations", () => {
  it("lists only what the viewer can open", () => {
    const forStudent = getNavDestinations(student, { caps: capabilities.student }).map((entry) => entry.id);
    expect(forStudent).toContain("coursework");
    expect(forStudent).toContain("profile");
    expect(forStudent.some((id) => id.startsWith("admin-") || id.startsWith("teach-"))).toBe(false);

    const off = getNavDestinations(instructor, { caps: capabilities.instructor_off }).map((entry) => entry.id);
    expect(off.some((id) => id.startsWith("teach-"))).toBe(false);
    const on = getNavDestinations(instructor, { caps: capabilities.instructor_on }).map((entry) => entry.id);
    expect(on).toContain("teach-grading");

    const forStaff = getNavDestinations(staff, { caps: capabilities.staff_off });
    expect(forStaff.find((entry) => entry.id === "admin-grading")).toMatchObject({ group: "Assessments", to: "/console/admin/grading" });
  });
});

describe("page modes", () => {
  it("keeps Carbon/legacy and flush classification", () => {
    expect(getShellPageMode("/console/admin/grading")).toBe("carbon");
    expect(getShellPageMode("/instructor/dashboard")).toBe("carbon");
    expect(getShellPageMode("/some-legacy-page")).toBe("legacy");
    expect(isFlushPage("/learn/3")).toBe(true);
    expect(isFlushPage("/reports")).toBe(false);
  });
});

describe("getCornerTileGroups (deprecated hub tiles)", () => {
  it("keeps the old tiles until the hub drops them", () => {
    expect(getCornerTileGroups(student).map((group) => group.id)).toEqual(["corner"]);
    expect(getCornerTileGroups(instructor).map((group) => group.id)).toEqual(["corner", "teach"]);
  });
});
