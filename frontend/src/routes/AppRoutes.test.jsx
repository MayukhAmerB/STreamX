import { Suspense } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AuthContext } from "../context/AuthContext";
import { act, renderTree } from "../test-utils/renderTree";
import AppRoutes from "./AppRoutes";

// Layouts and pages are replaced with labelled stand-ins: these tests cover
// which layout wraps each route and where guards redirect, not the pages.
vi.mock("../components/ScrollToTop", () => ({ default: () => null }));
vi.mock("../layouts/AppLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <div>{"website:"}<Outlet /></div> };
});
vi.mock("../features/app-shell/AppShellLayout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <div>{"shell:"}<Outlet /></div> };
});
vi.mock("../pages/LoginPage", async () => {
  const { useLocation: useLoc } = await import("react-router-dom");
  return {
    default: function LoginStub() {
      const location = useLoc();
      return `Login(from=${location.state?.from ?? ""})`;
    },
  };
});
vi.mock("../pages/TermsPage", async () => {
  const { useLocation: useLoc } = await import("react-router-dom");
  return {
    default: function TermsStub() {
      const location = useLoc();
      return `Terms(from=${location.state?.from ?? ""})`;
    },
  };
});
vi.mock("../pages/LandingPage", () => ({ default: () => "Landing" }));
vi.mock("../pages/WatchPage", () => ({ default: () => "Watch" }));
vi.mock("../pages/NotFoundPage", () => ({ default: () => "NotFound" }));
vi.mock("../pages/AboutPage", () => ({ default: () => "About" }));
vi.mock("../pages/CourseListPage", () => ({ default: () => "CourseList" }));
vi.mock("../pages/JoinLivePage", () => ({ default: () => "JoinLive" }));
vi.mock("../pages/MyCoursesPage", () => ({ default: () => "MyCourses" }));
vi.mock("../pages/UsersCornerPage", () => ({ default: () => "Console" }));
vi.mock("../pages/GuidesPage", () => ({ default: () => "Guides" }));
vi.mock("../pages/OsintToolsPage", () => ({ default: () => "OsintTools" }));
vi.mock("../pages/IdCardPage", () => ({ default: () => "IdCard" }));
vi.mock("../pages/AdminControlCenterPage", () => ({ default: () => "ControlCenter" }));
vi.mock("../pages/MeetingPage", () => ({ default: () => "Meeting" }));
vi.mock("../pages/BroadcastingPage", () => ({ default: () => "Broadcasting" }));
vi.mock("../pages/LectureQuestionsPage", () => ({ default: () => "LectureQuestions" }));
vi.mock("../pages/InstructorDashboardPage", () => ({ default: () => "InstructorDashboard" }));
vi.mock("../pages/CreateCoursePage", () => ({ default: () => "CreateCourse" }));
vi.mock("../pages/EditCoursePage", async () => {
  const { useParams } = await import("react-router-dom");
  return {
    default: function EditStub() {
      return `EditCourse(${useParams().id})`;
    },
  };
});

const users = {
  student: { id: 1, role: "student", is_admin: false },
  instructor: { id: 2, role: "instructor", is_admin: false },
  admin: { id: 3, role: "student", is_admin: true },
};

function authFor(kind, overrides = {}) {
  if (kind === "guest") {
    return { loading: false, isAuthenticated: false, isInstructor: false, isAdmin: false, user: null, ...overrides };
  }
  const user = users[kind];
  return {
    loading: false,
    isAuthenticated: true,
    isInstructor: user.role === "instructor",
    isAdmin: Boolean(user.is_admin),
    user,
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return ` @${location.pathname}${location.search}${location.hash}`;
}

async function renderAt(path, auth) {
  const tree = await renderTree(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <Suspense fallback="loading">
          <AppRoutes />
        </Suspense>
        <LocationProbe />
      </MemoryRouter>
    </AuthContext.Provider>
  );
  // Let the lazy route modules resolve.
  for (let attempt = 0; attempt < 20 && tree.text().includes("loading"); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const text = tree.text();
  await tree.unmount();
  return text;
}

describe("AppRoutes", () => {
  it.each([
    ["/control-center", "admin", "ControlCenter"],
    ["/control-center", "instructor", "ControlCenter"],
    ["/meeting", "admin", "Meeting"],
    ["/meeting", "instructor", "Meeting"],
    ["/broadcasting", "instructor", "Broadcasting"],
    ["/broadcasting", "admin", "Broadcasting"],
    ["/lecture-questions", "admin", "LectureQuestions"],
    ["/instructor/dashboard", "instructor", "InstructorDashboard"],
    ["/instructor/courses/new", "instructor", "CreateCourse"],
    ["/instructor/courses/77/edit", "instructor", "EditCourse(77)"],
  ])("renders staff route %s for %s inside the app shell", async (path, kind, page) => {
    expect(await renderAt(path, authFor(kind))).toBe(`shell:${page} @${path}`);
  });

  it("keeps deep links with query strings on staff routes", async () => {
    expect(await renderAt("/broadcasting?session=12", authFor("admin"))).toBe("shell:Broadcasting @/broadcasting?session=12");
  });

  it.each([
    // requireModerator -> /join-live
    ["/control-center", "student", "shell:JoinLive @/join-live"],
    ["/meeting", "student", "shell:JoinLive @/join-live"],
    ["/broadcasting", "student", "shell:JoinLive @/join-live"],
    // requireAdmin -> /join-live
    ["/lecture-questions", "student", "shell:JoinLive @/join-live"],
    ["/lecture-questions", "instructor", "shell:JoinLive @/join-live"],
    // requireInstructor -> /
    ["/instructor/dashboard", "student", "website:Landing @/"],
    ["/instructor/courses/new", "admin", "website:Landing @/"],
    ["/instructor/courses/5/edit", "student", "website:Landing @/"],
  ])("redirects %s for a %s exactly as before", async (path, kind, expected) => {
    expect(await renderAt(path, authFor(kind))).toBe(expected);
  });

  it.each(["/broadcasting", "/meeting", "/control-center", "/lecture-questions", "/instructor/dashboard", "/instructor/courses/5/edit", "/guides", "/id-card"])(
    "sends signed-out visitors from %s to login with the return path",
    async (path) => {
      expect(await renderAt(path, authFor("guest"))).toBe(`website:Login(from=${path}) @/login`);
    }
  );

  it("sends users who must accept new terms to /terms with the return path", async () => {
    const auth = authFor("instructor", { user: { ...users.instructor, terms_acceptance_required: true } });
    expect(await renderAt("/instructor/dashboard", auth)).toBe("website:Terms(from=/instructor/dashboard) @/terms");
  });

  it("shows the session check while auth is loading", async () => {
    const text = await renderAt("/broadcasting", authFor("guest", { loading: true }));
    expect(text).toContain("Checking session...");
    expect(text).toContain("@/broadcasting");
  });

  it.each([
    ["/guides", "Guides"],
    ["/osint-tools", "OsintTools"],
    ["/id-card", "IdCard"],
    ["/my-courses", "MyCourses"],
  ])("renders student page %s in the shell", async (path, page) => {
    expect(await renderAt(path, authFor("student"))).toBe(`shell:${page} @${path}`);
  });

  it.each([
    ["/", "Landing"],
    ["/about", "About"],
    ["/courses", "CourseList"],
  ])("keeps public page %s in the website layout", async (path, page) => {
    expect(await renderAt(path, authFor("guest"))).toBe(`website:${page} @${path}`);
  });

  it("serves the Console hub at /console inside the shell", async () => {
    expect(await renderAt("/console", authFor("student"))).toBe("shell:Console @/console");
  });

  it.each([
    ["/users-corner", "/console"],
    ["/users-corner/", "/console"],
    ["/users-corner?tab=live#next", "/console?tab=live#next"],
  ])("permanently redirects the old Console address %s to %s", async (path, target) => {
    expect(await renderAt(path, authFor("student"))).toBe(`shell:Console @${target}`);
  });

  it("sends signed-out visitors from the old Console address to login for /console", async () => {
    expect(await renderAt("/users-corner", authFor("guest"))).toBe("website:Login(from=/console) @/login");
  });

  it("serves the YouTube Watch page inside the website layout", async () => {
    expect(await renderAt("/watch", authFor("guest"))).toBe("website:Watch @/watch");
  });

  it.each(["/this-page-does-not-exist", "/courses/12/nope", "/watch/extra"])(
    "answers an unknown address %s with a real not-found page (no silent redirect home)",
    async (path) => {
      expect(await renderAt(path, authFor("guest"))).toBe(`website:NotFound @${path}`);
    }
  );
});
