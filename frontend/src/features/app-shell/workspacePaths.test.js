import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, teachToAdminPath, workspaceFor } from "./workspacePaths";

const staff = { isAdmin: true };
const instructor = { isInstructor: true };
const student = {};

function url(pathname, search, viewer) {
  const target = resolveWorkspacePath(pathname, search, viewer);
  return target ? `${target.pathname}${target.search}` : null;
}

describe("workspacePaths", () => {
  it("picks the workspace by role", () => {
    expect(workspaceFor(staff)).toBe("admin");
    expect(workspaceFor({ isAdmin: true, isInstructor: true })).toBe("admin");
    expect(workspaceFor(instructor)).toBe("teach");
    expect(workspaceFor(student)).toBeNull();
  });

  it.each([
    ["/control-center", "", "/console/admin", "/console/teach"],
    ["/instructor/dashboard", "", "/console/admin", "/console/teach"],
    ["/instructor/courses/new", "", "/console/admin/courses/new", "/console/teach/courses/new"],
    ["/instructor/courses/7/edit", "", "/console/admin/courses/7", "/console/teach/courses/7"],
    ["/meeting", "", "/console/admin/classes?mode=meeting", "/console/teach/classes?mode=meeting"],
    ["/broadcasting", "", "/console/admin/classes?mode=broadcast", "/console/teach/classes?mode=broadcast"],
    ["/broadcasting", "?session=12", "/console/admin/classes/12/studio", "/console/teach/classes/12/studio"],
    ["/console/recordings/upload", "", "/console/admin/recordings/upload", "/console/teach/recordings/upload"],
    ["/report-grading", "", "/console/admin/grading/tasks", "/console/teach/grading/tasks"],
    ["/report-grading/queue", "?task=4", "/console/admin/grading/queue?task=4", "/console/teach/grading/queue?task=4"],
    ["/report-grading/gradebook", "", "/console/admin/grading/marks", "/console/teach/grading/marks"],
    ["/report-grading/tasks/new", "", "/console/admin/grading/tasks/new", "/console/teach/grading/tasks/new"],
    ["/report-grading/tasks/9/edit", "", "/console/admin/grading/tasks/9/edit", "/console/teach/grading/tasks/9/edit"],
    ["/gradebook/students/5", "", "/console/admin/grading/students/5", "/console/teach/grading/students/5"],
    ["/console/exams", "", "/console/admin/exams", "/console/teach/exams"],
    ["/console/exams/osint-1", "", "/console/admin/exams/osint-1", "/console/teach/exams/osint-1"],
  ])("maps %s%s for staff and instructors", (pathname, search, forStaff, forInstructor) => {
    expect(url(pathname, search, staff)).toBe(forStaff);
    expect(url(pathname, search, instructor)).toBe(forInstructor);
    expect(url(pathname, search, student)).toBeNull();
  });

  it("sends lecture questions to the Community tab for staff only", () => {
    expect(url("/lecture-questions", "", staff)).toBe("/console/admin/community?tab=questions");
    expect(url("/lecture-questions", "", instructor)).toBeNull();
  });

  it("moves My marks to Grades for everyone", () => {
    expect(url("/reports/marks", "", student)).toBe("/gradebook");
    expect(url("/reports/marks", "", staff)).toBe("/gradebook");
  });

  it("ignores URLs that are not old ones", () => {
    expect(url("/console", "", staff)).toBeNull();
    expect(url("/my-courses", "", instructor)).toBeNull();
  });

  it("maps a Teach URL to the same Admin URL", () => {
    expect(teachToAdminPath("/console/teach")).toBe("/console/admin");
    expect(teachToAdminPath("/console/teach/grading/queue")).toBe("/console/admin/grading/queue");
    expect(teachToAdminPath("/console/teacher")).toBe("/console/teacher");
  });
});
