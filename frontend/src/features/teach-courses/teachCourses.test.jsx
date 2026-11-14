// Teach › Courses (WS-D2): curriculum reorder (keyboard), publish and preview
// toggles, validation, the on-device draft kept when Teaching switches off.
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fire, renderTree, textOf } from "../../test-utils/renderTree";
import { canAuthorCourse } from "./CourseEditorPage";
import CurriculumEditor from "./CurriculumEditor";
import {
  buildCoursePayload,
  clearCourseDraft,
  courseToForm,
  describeCurriculum,
  isCourseFormDirty,
  lectureUpdatePayload,
  loadCourseDraft,
  moveItem,
  publishBlocker,
  renumber,
  reorderKeyTarget,
  saveCourseDraft,
  validateCourseForm,
  validateLectureForm,
} from "./courseModel";
import { filterCourses } from "./TeachCoursesPage";

const saveLecture = vi.fn(() => Promise.resolve({ data: { data: {} } }));
const saveSection = vi.fn(() => Promise.resolve({ data: { data: {} } }));
vi.mock("./teachCoursesApi", () => ({
  saveLecture: (...args) => saveLecture(...args),
  saveSection: (...args) => saveSection(...args),
  createLecture: vi.fn(() => Promise.resolve({})),
  createSection: vi.fn(() => Promise.resolve({})),
  deleteLecture: vi.fn(() => Promise.resolve({})),
  deleteSection: vi.fn(() => Promise.resolve({})),
}));
// Icon buttons wrap a Carbon tooltip and the confirm dialog a Modal: both need a real DOM.
vi.mock("@carbon/react", async (importOriginal) => {
  const actual = await importOriginal();
  const IconButton = ({ label, children, align: _align, kind: _kind, size: _size, ...rest }) => (
    <button type="button" aria-label={label} {...rest}>
      {children}
    </button>
  );
  const Modal = ({ open, modalHeading, children }) => (open ? <div role="dialog" aria-label={modalHeading}>{children}</div> : null);
  return { ...actual, IconButton, Modal };
});
vi.mock("../app-shell/ui/toast", () => ({ useToast: () => ({ showToast: vi.fn() }), ToastProvider: ({ children }) => children }));

const course = {
  id: 9,
  title: "OSINT Foundations",
  is_published: false,
  instructor: { id: 2 },
  sections: [
    {
      id: 21,
      title: "Search basics",
      description: "",
      order: 1,
      lectures: [
        { id: 31, title: "Operators", description: "", order: 1, is_preview: false },
        { id: 32, title: "Dorks", description: "", order: 2, is_preview: true },
        { id: 33, title: "Archives", description: "", order: 3, is_preview: false },
      ],
    },
    { id: 22, title: "People", description: "Profiles", order: 2, lectures: [] },
  ],
};

describe("reordering", () => {
  beforeEach(() => {
    globalThis.window = globalThis.window || {};
    globalThis.window.requestAnimationFrame = (callback) => callback();
  });

  it("moves an item and renumbers only the rows that changed", () => {
    const moved = moveItem(course.sections[0].lectures, 2, 0);
    expect(moved.map((item) => item.id)).toEqual([33, 31, 32]);
    const { items, changed } = renumber(moved);
    expect(items.map((item) => item.order)).toEqual([1, 2, 3]);
    expect(changed).toEqual([
      { id: 33, order: 1 },
      { id: 31, order: 2 },
      { id: 32, order: 3 },
    ]);
    expect(moveItem([1, 2, 3], 1, 9)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });

  it("maps Alt + arrows / Home / End to a new position", () => {
    expect(reorderKeyTarget({ altKey: true, key: "ArrowUp" }, 1, 3)).toBe(0);
    expect(reorderKeyTarget({ altKey: true, key: "ArrowDown" }, 1, 3)).toBe(2);
    expect(reorderKeyTarget({ altKey: true, key: "Home" }, 2, 3)).toBe(0);
    expect(reorderKeyTarget({ altKey: true, key: "End" }, 0, 3)).toBe(2);
    expect(reorderKeyTarget({ altKey: true, key: "ArrowUp" }, 0, 3)).toBeNull();
    expect(reorderKeyTarget({ key: "ArrowUp" }, 1, 3)).toBeNull();
    expect(reorderKeyTarget({ altKey: true, ctrlKey: true, key: "ArrowUp" }, 1, 3)).toBeNull();
  });

  it("reorders a lecture from the keyboard and saves the new order", async () => {
    saveLecture.mockClear();
    const onChanged = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <CurriculumEditor course={course} canEdit onChanged={onChanged} />
      </MemoryRouter>
    );
    const rows = tree.all((node) => node.type === "li" && String(node.props.className).includes("tch-lecture"));
    expect(rows.map((row) => row.props["aria-label"])).toEqual([
      "Lecture 1 of 3: Operators. Alt plus arrow keys move it.",
      "Lecture 2 of 3: Dorks. Alt plus arrow keys move it.",
      "Lecture 3 of 3: Archives. Alt plus arrow keys move it.",
    ]);
    await fire(rows[2], "onKeyDown", { altKey: true, key: "ArrowUp", target: rows[2], currentTarget: rows[2] });
    const after = tree.all((node) => node.type === "li" && String(node.props.className).includes("tch-lecture"));
    expect(after.map((row) => row.props["aria-label"].split(": ")[1].split(".")[0])).toEqual(["Operators", "Archives", "Dorks"]);
    expect(tree.text()).toContain("Moved “Archives” to position 2 of 3.");
    expect(saveLecture).toHaveBeenCalledTimes(2);
    expect(saveLecture).toHaveBeenCalledWith(33, expect.objectContaining({ section: 21, order: 2, title: "Archives" }));
    expect(saveLecture).toHaveBeenCalledWith(32, expect.objectContaining({ section: 21, order: 3, is_preview: true }));
    await tree.unmount();
  });

  it("toggles a lecture's free preview through a real switch", async () => {
    saveLecture.mockClear();
    const tree = await renderTree(
      <MemoryRouter>
        <CurriculumEditor course={course} canEdit onChanged={() => {}} />
      </MemoryRouter>
    );
    const switches = tree.all((node) => node.props?.role === "switch");
    expect(switches.map((node) => node.props["aria-checked"])).toEqual([false, true, false]);
    await fire(switches[0], "onClick");
    expect(saveLecture).toHaveBeenCalledWith(31, expect.objectContaining({ is_preview: true, order: 1 }));
    const after = tree.all((node) => node.props?.role === "switch");
    expect(after[0].props["aria-checked"]).toBe(true);
    await tree.unmount();
  });

  it("is read-only for viewers who cannot author the course", async () => {
    const tree = await renderTree(
      <MemoryRouter>
        <CurriculumEditor course={course} canEdit={false} onChanged={() => {}} />
      </MemoryRouter>
    );
    expect(tree.all((node) => node.props?.role === "switch")).toHaveLength(0);
    expect(tree.text()).not.toContain("Add lecture");
    expect(tree.text()).toContain("Free preview");
    await tree.unmount();
  });
});

describe("course form", () => {
  it("validates the basics with plain messages", () => {
    expect(validateCourseForm({ title: "", description: "", price: "" })).toEqual({
      title: "Give the course a title.",
      description: "Say in a sentence or two what students learn.",
      price: "Enter a price in rupees (0 for free).",
    });
    expect(validateCourseForm({ title: "A", description: "B", price: "2499.5", thumbnail: "ftp://x" })).toEqual({ thumbnail: "Use a full link starting with https://" });
    expect(validateCourseForm({ title: "A", description: "B", price: "0" })).toEqual({});
  });

  it("knows when the form differs from what is saved", () => {
    const saved = courseToForm({ title: "A", description: "B", price: "10.00", thumbnail: "https://x/media/c.jpg" });
    expect(saved.thumbnail).toBe("");
    expect(isCourseFormDirty({ ...saved }, saved)).toBe(false);
    expect(isCourseFormDirty({ ...saved, title: "A2" }, saved)).toBe(true);
    expect(isCourseFormDirty({ ...saved, thumbnail_file: { name: "c.png" } }, saved)).toBe(true);
  });

  it("builds the multipart payload the API expects", () => {
    const payload = buildCoursePayload({ title: "T", description: "D", price: "99", thumbnail: "", is_published: true });
    expect(payload.get("title")).toBe("T");
    expect(payload.get("is_published")).toBe("true");
    expect(payload.has("thumbnail_file")).toBe(false);
  });

  it("needs a lecture title and a video file or key", () => {
    expect(validateLectureForm({ title: "", video_key: "" })).toEqual({ title: "Give the lecture a title.", video: "Add a video file, or the storage key or link of one." });
    expect(validateLectureForm({ title: "x", video_key: "lectures/a.mp4" })).toEqual({});
    expect(lectureUpdatePayload(4, { title: "x", order: 2, is_preview: 0 }, { order: 1 })).toEqual({ section: 4, title: "x", description: "", order: 1, is_preview: false });
  });

  it("explains why a course cannot be published yet", () => {
    expect(publishBlocker({ sections: [] })).toBe("Add at least one lecture before publishing.");
    expect(publishBlocker(course)).toBe("");
    expect(describeCurriculum({ modules: 1, lectures: 3 })).toBe("1 module · 3 lectures");
  });

  it("lets only the course's instructor author it", () => {
    expect(canAuthorCourse({ id: 2, role: "instructor" }, course)).toBe(true);
    expect(canAuthorCourse({ id: 3, role: "instructor" }, course)).toBe(false);
    expect(canAuthorCourse({ id: 1, role: "student", is_admin: true }, course)).toBe(false);
    expect(canAuthorCourse({ id: 3, role: "instructor" }, null)).toBe(true);
  });
});

describe("unsaved edits on this device", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.window = globalThis.window || {};
    globalThis.window.sessionStorage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    };
  });
  afterEach(() => {
    delete globalThis.window.sessionStorage;
  });

  it("keeps the text fields (never files) and clears them after saving", () => {
    expect(saveCourseDraft(9, { title: "Draft", description: "D", price: "5", thumbnail: "", thumbnail_file: { name: "big.png" } })).toBe(true);
    const draft = loadCourseDraft(9);
    expect(draft).toMatchObject({ title: "Draft", description: "D", price: "5", thumbnail: "" });
    expect(JSON.stringify([...store.values()])).not.toContain("big.png");
    clearCourseDraft(9);
    expect(loadCourseDraft(9)).toBeNull();
  });

  it("survives blocked or broken storage", () => {
    globalThis.window.sessionStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveCourseDraft(9, { title: "x" })).toBe(false);
    expect(loadCourseDraft(9)).toBeNull();
    expect(() => clearCourseDraft(9)).not.toThrow();
  });
});

describe("course list", () => {
  const items = [
    { id: 1, title: "OSINT Foundations", description: "Search", is_published: true },
    { id: 2, title: "Dark web basics", description: "Tor", is_published: false },
  ];
  it("filters by status chip and search text", () => {
    expect(filterCourses(items, { filter: "draft" }).map((item) => item.id)).toEqual([2]);
    expect(filterCourses(items, { filter: "published" }).map((item) => item.id)).toEqual([1]);
    expect(filterCourses(items, { query: "tor" }).map((item) => item.id)).toEqual([2]);
    expect(filterCourses(items, {}).length).toBe(2);
  });
});

describe("catalogue tier (hackpath)", () => {
  it("shows the tier read-only when the API returns one, and nothing otherwise", async () => {
    const { CatalogTier } = await import("./CourseOverviewForm");
    const tree = await renderTree(<CatalogTier course={{ tier: "foundations", tier_label: "Foundations", tier_order: 2 }} />);
    const block = tree.find((node) => node.props?.["data-testid"] === "course-tier");
    expect(block).not.toBeNull();
    expect(textOf(block)).toContain("Foundations · position 2");
    await tree.unmount();
    const empty = await renderTree(<CatalogTier course={{ tier: "", tier_label: "" }} />);
    expect(empty.find((node) => node.props?.["data-testid"] === "course-tier")).toBeNull();
    await empty.unmount();
  });
});
