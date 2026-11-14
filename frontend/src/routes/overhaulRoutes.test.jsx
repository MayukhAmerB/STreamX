import { Suspense } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import capabilities from "../__contracts__/ui-overhaul/capabilities.json";
import { AuthContext } from "../context/AuthContext";
import { act, renderTree } from "../test-utils/renderTree";
import AppRoutes from "./AppRoutes";
import { OVERHAUL_PATHS } from "./overhaulRoutes";

// Layouts and existing pages are labelled stand-ins; the new placeholder
// pages, the workspace guard and the feature gate render for real.
vi.mock("../components/ScrollToTop", () => ({ default: () => null }));
vi.mock("../layouts/AppLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <div>{"website:"}<Outlet /></div> };
});
vi.mock("../features/app-shell/AppShellLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <div>{"shell:"}<Outlet /></div> };
});
vi.mock("../pages/LoginPage", () => ({ default: () => "Login" }));
vi.mock("../pages/ConsoleExamsPage", () => ({ default: () => "ConsoleExams" }));
vi.mock("../pages/ConsoleExamDetailPage", () => ({ default: () => "ConsoleExamDetail" }));
vi.mock("../pages/ConsoleRecordingUploadPage", () => ({ default: () => "RecordingUpload" }));

// Page modules of other workstreams: labelled stand-ins (this test covers routing and guards).
vi.mock("../features/admin/AdminHomePage", () => ({ default: () => "Admin" }));
vi.mock("../features/admin/AdminActivityPage", () => ({ default: () => "Activity" }));
vi.mock("../features/admin/AdminRequestsPage", () => ({ default: () => "Requests" }));
vi.mock("../features/admin/AdminRecordingsPage", () => ({ default: () => "Recordings" }));
vi.mock("../features/admin/AdminCommunityPage", () => ({ default: () => "Community" }));
vi.mock("../features/admin/AdminFeaturesPage", () => ({ default: () => "Features" }));
vi.mock("../features/admin/AdminHealthPage", () => ({ default: () => "Health" }));
vi.mock("../features/admin/AdminBackOfficePage", () => ({ default: ({ section }) => `BackOffice(${section})` }));
vi.mock("../features/teach-today/TeachTodayPage", () => ({ default: () => "Today" }));
vi.mock("../features/teach-courses/TeachCoursesPage", () => ({ default: () => "Courses" }));
vi.mock("../features/teach-courses/CourseEditorPage", () => ({ default: () => "CourseEditor" }));
vi.mock("../features/grading/GradingPage", () => ({ default: () => "Grading" }));
vi.mock("../features/grading/GradingTaskEditorPage", () => ({ default: () => "GradingTaskEditor" }));
vi.mock("../features/grading/GradingStudentPage", () => ({ default: () => "GradingStudent" }));
vi.mock("../features/classes/ClassesPage", () => ({ default: () => "Classes" }));
vi.mock("../features/classes/HostStudioPage", () => ({ default: () => "Host studio" }));
vi.mock("../features/recording-uploads/MyRecordingsPage", () => ({ default: () => "MyRecordings" }));
vi.mock("../features/coursework/CourseworkExamsPage", () => ({ default: () => "Exams" }));

const capsState = { caps: null, loading: false };
vi.mock("../features/capabilities/useCapabilities", () => ({
  default: () => ({ ...capsState, refresh: () => Promise.resolve(capsState.caps) }),
  resetCapabilitiesCache: () => {},
}));

const users = {
  student: { id: 1, role: "student", is_admin: false },
  instructor: { id: 2, role: "instructor", is_admin: false },
  admin: { id: 3, role: "student", is_admin: true },
};

function authFor(kind) {
  if (kind === "guest") return { loading: false, isAuthenticated: false, isInstructor: false, isAdmin: false, user: null };
  const user = users[kind];
  return { loading: false, isAuthenticated: true, isInstructor: user.role === "instructor", isAdmin: Boolean(user.is_admin), user };
}

function LocationProbe() {
  const location = useLocation();
  return ` @${location.pathname}${location.search}`;
}

async function renderAt(path, kind) {
  const tree = await renderTree(
    <AuthContext.Provider value={authFor(kind)}>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback="loading">
          <AppRoutes />
        </Suspense>
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>
  );
  // Lazy modules (Carbon on first import) can take a few seconds cold.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && tree.text().includes("loading")) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  const text = tree.text();
  await tree.unmount();
  return text;
}

function concrete(path) {
  return path.replace(":id", "7").replace(":sessionId", "5").replace(":tab", "queue").replace(":taskId", "9").replace(":studentId", "3").replace(":slug", "osint-1");
}

// Warm the lazy route modules once (Carbon is slow to import cold on a busy machine).
beforeAll(async () => {
  await Promise.all([import("./WorkspaceGuard"), import("../features/app-shell/ui"), import("../features/capabilities")]);
}, 60000);

beforeEach(() => {
  capsState.caps = null;
  capsState.loading = false;
});

describe("UI overhaul routes", { timeout: 30000 }, () => {
  it.each([
    ["/console/admin", "Admin"],
    ["/console/admin/activity", "Activity"],
    ["/console/admin/requests", "Requests"],
    ["/console/admin/recordings", "Recordings"],
    ["/console/admin/community", "Community"],
    ["/console/admin/settings/features", "Features"],
    ["/console/admin/system/health", "Health"],
    ["/console/admin/payments", "BackOffice(payments)"],
    ["/console/admin/classes/chat", "BackOffice(chat)"],
    ["/console/admin/courses", "Courses"],
    ["/console/admin/courses/new", "CourseEditor"],
    ["/console/admin/courses/7", "CourseEditor"],
    ["/console/admin/classes", "Classes"],
    ["/console/admin/classes/5/studio", "Host studio"],
    ["/console/admin/grading", "Grading"],
    ["/console/admin/grading/tasks/9/edit", "GradingTaskEditor"],
    ["/console/admin/grading/students/3", "GradingStudent"],
    ["/console/admin/exams", "ConsoleExams"],
    ["/console/admin/exams/osint-1", "ConsoleExamDetail"],
    ["/console/admin/recordings/upload", "RecordingUpload"],
  ])("renders %s for staff inside the shell", async (path, title) => {
    const text = await renderAt(path, "admin");
    expect(text.startsWith("shell:")).toBe(true);
    expect(text).toContain(title);
    expect(text.endsWith(`@${path}`)).toBe(true);
  });

  it("renders every new path for its owner without falling through to the website", async () => {
    for (const path of OVERHAUL_PATHS.map(concrete)) {
      const kind = path.startsWith("/console/teach") ? "instructor" : path.startsWith("/console/admin") ? "admin" : "student";
      capsState.caps = capabilities.instructor_on;
      const text = await renderAt(path, kind);
      expect(text, path).toMatch(/^shell:/);
      expect(text, path).not.toContain("This page does not exist");
      expect(text, path).not.toContain("Teaching is switched off");
    }
  });

  it("sends staff from a Teach URL to the same Admin URL", async () => {
    const text = await renderAt("/console/teach/grading/queue?task=4", "admin");
    expect(text).toContain("Grading");
    expect(text.endsWith("@/console/admin/grading/queue?task=4")).toBe(true);
  });

  it("shows instructors the switched-off page with the reason while Teaching is off (no redirect)", async () => {
    capsState.caps = capabilities.instructor_off;
    const text = await renderAt("/console/teach/courses", "instructor");
    expect(text).toContain("Teaching is switched off");
    expect(text).toContain(capabilities.instructor_off.workspaces.teach.reason);
    expect(text).toContain("Back to Home");
    expect(text.endsWith("@/console/teach/courses")).toBe(true);
  });

  it("shows 'Checking…' while capabilities load", async () => {
    capsState.loading = true;
    expect(await renderAt("/console/teach", "instructor")).toContain("Checking…");
  });

  it("opens Teach pages for instructors when Teaching is on", async () => {
    capsState.caps = capabilities.instructor_on;
    expect(await renderAt("/console/teach", "instructor")).toContain("Today");
    expect(await renderAt("/console/teach/exams", "instructor")).toContain("ConsoleExams");
  });

  it.each([
    ["/console/teach", "student"],
    ["/console/admin", "student"],
    ["/console/admin/requests", "instructor"],
  ])("answers %s for a %s with not found inside the shell", async (path, kind) => {
    capsState.caps = capabilities.instructor_on;
    const text = await renderAt(path, kind);
    expect(text).toContain("shell:");
    expect(text).toContain("This page does not exist");
    expect(text.endsWith(`@${path}`)).toBe(true);
  });

  it("sends signed-out visitors to login", async () => {
    expect(await renderAt("/console/admin", "guest")).toBe("website:Login @/login");
  });

  it("serves Coursework › Exams to students", async () => {
    expect(await renderAt("/coursework/exams", "student")).toContain("Exams");
  });
});
