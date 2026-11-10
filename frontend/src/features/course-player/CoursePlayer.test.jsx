import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../context/AuthContext";
import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import CoursePlayer from "./CoursePlayer";
import { envelope, makeCourse } from "./testFixtures";

const mocks = vi.hoisted(() => ({
  getCourse: vi.fn(),
  getLectureVideoUrl: vi.fn(),
  updateLectureProgress: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("hls.js", () => ({ default: { isSupported: () => false, Events: {} } }));
// The real surface drives fullscreen/gestures through the DOM; its own
// behaviour is covered elsewhere. Here it only needs to render the video.
vi.mock("../../components/ProtectedPlaybackSurface", () => ({
  default: ({ children }) => <div data-surface="true">{children}</div>,
}));
vi.mock("@carbon/react", async (importOriginal) => {
  const actual = await importOriginal();
  // Minimal tabs (Carbon's measure the DOM): every panel rendered, selected one visible.
  const Tabs = ({ children }) => <div data-tabs="true">{children}</div>;
  const TabList = ({ children }) => <div role="tablist">{children}</div>;
  const Tab = ({ children }) => <button role="tab">{children}</button>;
  const TabPanels = ({ children }) => <div>{children}</div>;
  const TabPanel = ({ children }) => <div role="tabpanel">{children}</div>;
  // Form controls/notifications probe DOM element classes; plain stand-ins suffice here.
  const TextArea = ({ labelText, helperText: _helperText, invalidText: _invalidText, invalid: _invalid, ...props }) => (
    <textarea aria-label={labelText} {...props} />
  );
  const InlineNotification = ({ title, subtitle }) => (
    <div role="status">
      {title} {subtitle}
    </div>
  );
  return { ...actual, Tabs, TabList, Tab, TabPanels, TabPanel, TextArea, InlineNotification };
});
vi.mock("../../api/courses", () => ({
  getCourse: mocks.getCourse,
  getLectureVideoUrl: mocks.getLectureVideoUrl,
  updateLectureProgress: mocks.updateLectureProgress,
  getLectureNote: vi.fn(async () => envelope({ content: "", updated_at: null })),
  updateLectureNote: vi.fn(async (_id, payload) => envelope({ content: payload.content, updated_at: "2026-11-10T12:00:00Z" })),
  getLectureQuestions: vi.fn(async () => envelope([])),
  createLectureQuestion: vi.fn(),
}));
vi.mock("../../api/lectureEngagement", async () => {
  const { createMockEngagementApi } = await import("./testFixtures");
  const api = createMockEngagementApi();
  return {
    getLectureEngagement: api.getSummary,
    setLectureLike: api.setLike,
    toggleLectureLike: vi.fn(),
    listLectureComments: api.listComments,
    createLectureComment: api.createComment,
    updateLectureComment: api.updateComment,
    deleteLectureComment: api.deleteComment,
  };
});
vi.mock("../app-shell/ui/toast", () => ({
  useToast: () => ({ showToast: mocks.toast, dismissToast: () => {} }),
  ToastProvider: ({ children }) => children,
}));

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const auth = {
  user: { id: 3, full_name: "Asha Rao", role: "student" },
  isAuthenticated: true,
  isInstructor: false,
  isAdmin: false,
};

async function renderPlayer({ course = makeCourse(), path = "/learn/29" } = {}) {
  mocks.getCourse.mockImplementation(async () => envelope(course));
  const view = await renderTree(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[path]}>
        <CoursePlayer courseId="29" />
      </MemoryRouter>
    </AuthContext.Provider>
  );
  await flush();
  await flush();
  return view;
}

const title = (view) => textOf(view.find((node) => node.type === "h1"));
const video = (view) => view.find((node) => node.type === "video");

beforeAll(() => {
  // Just enough of a browser for the playback listeners (no layout, no media).
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, scrollY: 0, scrollTo() {} });
  // Carbon's TextArea / notifications probe these when a window exists.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  for (const name of ["HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement"]) {
    vi.stubGlobal(name, class {});
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLectureVideoUrl.mockImplementation(async (id) =>
    envelope({ signed_url: `https://media.example/lecture-${id}.mp4`, playback_type: "file" })
  );
  mocks.updateLectureProgress.mockImplementation(async (_id, payload) =>
    envelope({ completed: Boolean(payload.completed), percent_complete: payload.completed ? 100 : 40, last_position_seconds: payload.position_seconds })
  );
});

describe("CoursePlayer", () => {
  it("resumes the last watched lesson with its outline, actions and tabs", async () => {
    const view = await renderPlayer();
    expect(title(view)).toBe("Search operators");
    expect(mocks.getLectureVideoUrl).toHaveBeenCalledWith(12);
    expect(video(view).props.className).toBe("cp-video");
    const text = view.text();
    expect(text).toContain("Course content");
    expect(text).toContain("Foundations");
    expect(text).toContain("Lesson 2 of 4");
    expect(text).toContain("Mark complete");
    expect(view.getByLabel("button", "Like this lesson, 4 likes")).toBeTruthy();
    expect(view.all((node) => node.props?.role === "tab").map(textOf)).toEqual(["Overview", "Comments", "Notes", "Q&A"]);
  });

  it("opens a deep-linked lesson", async () => {
    const view = await renderPlayer({ path: "/learn/29?lesson=22" });
    expect(title(view)).toBe("Images");
  });

  it("moves to the next and previous lesson", async () => {
    const view = await renderPlayer();
    await fire(view.getByLabel("button", "Next lesson: Maps"), "onClick");
    await flush();
    expect(title(view)).toBe("Maps");
    expect(mocks.getLectureVideoUrl).toHaveBeenLastCalledWith(21);
    await fire(view.getByLabel("button", "Previous lesson: Search operators"), "onClick");
    await flush();
    expect(title(view)).toBe("Search operators");
  });

  it("saves the position when switching lessons", async () => {
    const view = await renderPlayer();
    const element = video(view);
    element.currentTime = 200;
    element.duration = 900;
    await fire(view.getByLabel("button", "Next lesson: Maps"), "onClick");
    await flush();
    expect(mocks.updateLectureProgress).toHaveBeenCalledWith(12, { position_seconds: 200, duration_seconds: 900 });
  });

  it("marks a lesson complete instantly", async () => {
    const view = await renderPlayer();
    const chip = view.find((node) => node.type === "button" && textOf(node) === "Mark complete");
    await fire(chip, "onClick");
    await flush();
    expect(mocks.updateLectureProgress).toHaveBeenCalledWith(12, expect.objectContaining({ completed: true }));
    const done = view.find((node) => node.type === "button" && textOf(node) === "Completed");
    expect(done.props["aria-pressed"]).toBe("true");
  });

  it("offers the next lesson with a cancellable countdown when the video ends", async () => {
    const view = await renderPlayer();
    await act(async () => video(view).dispatch("ended"));
    await flush();
    expect(view.text()).toContain("Up next in 5");
    expect(view.text()).toContain("Maps");
    await fire(view.getByLabel("button", "Cancel"), "onClick");
    expect(view.text()).not.toContain("Up next in");
    expect(title(view)).toBe("Search operators");

    await act(async () => video(view).dispatch("ended"));
    await fire(view.getByLabel("button", "Play now"), "onClick");
    await flush();
    expect(title(view)).toBe("Maps");
    expect(mocks.updateLectureProgress).toHaveBeenCalledWith(12, expect.objectContaining({ completed: true }));
  });

  it("shows a locked lesson with a clear enroll action and never requests its video", async () => {
    const course = makeCourse({ is_enrolled: false });
    course.sections[0].lectures.forEach((lecture) => {
      lecture.progress = null;
    });
    const view = await renderPlayer({ course, path: "/learn/29?lesson=21" });
    expect(title(view)).toBe("Maps");
    expect(view.text()).toContain("This lesson is locked");
    const enroll = view.find((node) => node.type === "a" && node.props.href === "/courses/29" && textOf(node) === "Enroll now");
    expect(enroll).toBeTruthy();
    expect(view.text()).toContain("Watch preview");
    expect(mocks.getLectureVideoUrl).not.toHaveBeenCalled();
    expect(view.find((node) => node.type === "button" && textOf(node) === "Mark complete")).toBeNull();
  });

  it("shows a friendly message for a missing course", async () => {
    mocks.getCourse.mockReset();
    const view = await renderTree(
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <CoursePlayer courseId="404" />
        </MemoryRouter>
      </AuthContext.Provider>
    );
    mocks.getCourse.mockRejectedValue({ response: { status: 404 } });
    await view.rerender(
      <AuthContext.Provider value={auth}>
        <MemoryRouter>
          <CoursePlayer key="retry" courseId="405" />
        </MemoryRouter>
      </AuthContext.Provider>
    );
    await flush();
    expect(view.text()).toContain("This course isn't available");
  });

  it("never shows a view count", async () => {
    const course = makeCourse();
    course.sections[0].lectures[1].view_count = 4321;
    const view = await renderPlayer({ course });
    expect(view.text()).not.toContain("4321");
    expect(view.text()).not.toMatch(/\bviews?\b/i);
  });
});
