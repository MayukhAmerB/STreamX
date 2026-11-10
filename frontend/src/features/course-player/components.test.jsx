import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import CommentsPanel from "./CommentsPanel";
import CourseOutline from "./CourseOutline";
import LessonActions from "./LessonActions";
import LessonHeader from "./LessonHeader";
import { buildCourseOutline, flattenCourseLectures, resolveLectureDescriptions } from "./outlineModel";
import OverviewPanel from "./OverviewPanel";
import { createMockEngagementApi, deferred, envelope, makeComment, makeCourse } from "./testFixtures";
import { useLectureEngagement } from "./useLectureEngagement";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("../app-shell/ui/toast", () => ({
  useToast: () => ({ showToast: toastSpy, dismissToast: () => {} }),
  ToastProvider: ({ children }) => children,
}));

const NOW = Date.parse("2026-11-10T12:00:00Z");
const AUTHOR = { id: 3, display_name: "Asha Rao", is_instructor: false };

/** Settles pending promises (mock API calls) and the renders they trigger. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

function EngagementHarness({ api, isAuthenticated = true, locked = false, onOpenComments = () => {} }) {
  const engagement = useLectureEngagement(7, { enabled: isAuthenticated && !locked, api });
  return (
    <MemoryRouter>
      <LessonActions
        engagement={engagement}
        isAuthenticated={isAuthenticated}
        locked={locked}
        loginState={{ from: "/learn/29" }}
        previousLecture={null}
        nextLecture={{ id: 8, title: "Search operators" }}
        onPrevious={() => {}}
        onNext={() => {}}
        onOpenComments={onOpenComments}
        completed={false}
        completing={false}
        onToggleComplete={() => {}}
      />
      <CommentsPanel
        engagement={engagement}
        isAuthenticated={isAuthenticated}
        locked={locked}
        enrollHref="/courses/29"
        loginState={{ from: "/learn/29" }}
        author={AUTHOR}
        now={NOW}
      />
    </MemoryRouter>
  );
}

async function renderEngagement(props) {
  const view = await renderTree(<EngagementHarness {...props} />);
  await flush();
  return view;
}

const likeButton = (view) => view.find((node) => node.type === "button" && node.props["aria-pressed"] !== undefined && String(node.props["aria-label"]).startsWith("Like"));

beforeEach(() => {
  toastSpy.mockClear();
});

describe("Like button", () => {
  it("toggles optimistically with aria-pressed and the count", async () => {
    const request = deferred();
    const api = createMockEngagementApi({ setLike: vi.fn(() => request.promise) });
    const view = await renderEngagement({ api });

    expect(likeButton(view).props["aria-pressed"]).toBe("false");
    expect(textOf(likeButton(view))).toBe("4");

    await fire(likeButton(view), "onClick");
    expect(likeButton(view).props["aria-pressed"]).toBe("true");
    expect(textOf(likeButton(view))).toBe("5");
    expect(api.setLike).toHaveBeenCalledWith(7, true);

    await act(async () => request.resolve(envelope({ like_count: 5, liked: true, comment_count: 2 })));
    await flush();
    expect(likeButton(view).props["aria-pressed"]).toBe("true");
  });

  it("rolls back and shows a toast when the like fails", async () => {
    const request = deferred();
    const api = createMockEngagementApi({ setLike: vi.fn(() => request.promise) });
    const view = await renderEngagement({ api });

    await fire(likeButton(view), "onClick");
    expect(textOf(likeButton(view))).toBe("5");

    await act(async () => request.reject({ response: { status: 429 } }));
    await flush();
    expect(likeButton(view).props["aria-pressed"]).toBe("false");
    expect(textOf(likeButton(view))).toBe("4");
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "You're going a bit fast" }));
  });

  it("jumps to comments from the Comments chip", async () => {
    const onOpenComments = vi.fn();
    const view = await renderEngagement({ api: createMockEngagementApi(), onOpenComments });
    const chip = view.getByLabel("button", "Comments, 2 comments");
    await fire(chip, "onClick");
    expect(onOpenComments).toHaveBeenCalled();
  });
});

describe("Comments", () => {
  const composerForm = (view, variant) =>
    view.find((node) => node.type === "form" && String(node.props.className).includes(`cp-composer--${variant}`));
  const textareaIn = (form) => {
    let found = null;
    const visit = (node) => {
      if (found || !node) return;
      if (node.type === "textarea") found = node;
      (node.children || []).forEach(visit);
    };
    visit(form);
    return found;
  };

  it("lists comments with author, Instructor tag, relative time and Edited marker", async () => {
    const api = createMockEngagementApi({
      listComments: vi.fn(async () =>
        envelope({
          results: [
            makeComment({ is_edited: true }),
            makeComment({ id: 2, is_mine: false, can_delete: false, author: { id: 9, display_name: "Imran Syed", is_instructor: true }, created_at: "2026-11-10T11:55:00Z" }),
          ],
          pagination: { page: 1, has_next: false, total: 2 },
        })
      ),
    });
    const view = await renderEngagement({ api });
    const text = view.text();
    expect(text).toContain("Asha Rao");
    expect(text).toContain("Imran Syed");
    expect(text).toContain("Instructor");
    expect(text).toContain("2h ago");
    expect(text).toContain("5m ago");
    expect(text).toContain("Edited");
    // Only my own comment offers Edit / Delete.
    expect(view.all((node) => node.type === "button" && textOf(node) === "Edit")).toHaveLength(1);
  });

  it("posts a comment optimistically, then shows the saved comment", async () => {
    const request = deferred();
    const api = createMockEngagementApi({ createComment: vi.fn(() => request.promise) });
    const view = await renderEngagement({ api });

    const form = composerForm(view, "inline");
    await fire(textareaIn(form), "onChange", { target: { value: "Really clear explanation" } });
    await fire(composerForm(view, "inline"), "onSubmit");

    expect(view.text()).toContain("Really clear explanation");
    expect(view.text()).toContain("Posting…");
    expect(textareaIn(composerForm(view, "inline")).props.value).toBe("");
    expect(api.createComment).toHaveBeenCalledWith(7, "Really clear explanation");

    await act(async () => request.resolve(envelope(makeComment({ id: 77, body: "Really clear explanation" }))));
    await flush();
    expect(view.text()).toContain("Really clear explanation");
    expect(view.text()).not.toContain("Posting…");
    expect(view.text()).toContain("Comments 3");
  });

  it("restores the draft when posting fails", async () => {
    const api = createMockEngagementApi({ createComment: vi.fn().mockRejectedValue({ response: { status: 500 } }) });
    const view = await renderEngagement({ api });
    await fire(textareaIn(composerForm(view, "inline")), "onChange", { target: { value: "Lost?" } });
    await fire(composerForm(view, "inline"), "onSubmit");
    await flush();
    expect(textareaIn(composerForm(view, "inline")).props.value).toBe("Lost?");
    expect(view.all((node) => node.type === "li" && textOf(node).includes("Lost?"))).toHaveLength(0);
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't post your comment" }));
  });

  it("edits my comment in place", async () => {
    const api = createMockEngagementApi();
    const view = await renderEngagement({ api });
    await fire(view.getByLabel("button", "Edit"), "onClick");
    const editForm = composerForm(view, "edit");
    expect(textareaIn(editForm).props.value).toBe("First comment");
    await fire(textareaIn(editForm), "onChange", { target: { value: "First comment, updated" } });
    await fire(composerForm(view, "edit"), "onSubmit");
    await flush();
    expect(api.updateComment).toHaveBeenCalledWith(1, "First comment, updated");
    expect(view.text()).toContain("First comment, updated");
    expect(view.text()).toContain("Edited");
    expect(composerForm(view, "edit")).toBeNull();
  });

  it("asks before deleting, then removes the comment", async () => {
    const api = createMockEngagementApi();
    const view = await renderEngagement({ api });
    await fire(view.getByLabel("button", "Delete"), "onClick");
    expect(view.text()).toContain("Delete this comment?");
    expect(api.deleteComment).not.toHaveBeenCalled();
    const confirm = view.find((node) => node.props?.role === "group" && node.props["aria-label"] === "Delete this comment?");
    const confirmDelete = confirm.children.find((node) => node.type === "button" && textOf(node) === "Delete");
    await fire(confirmDelete, "onClick");
    await flush();
    expect(api.deleteComment).toHaveBeenCalledWith(1);
    expect(view.text()).not.toContain("First comment");
    expect(view.text()).toContain("Comments 1");
  });

  it("shows the empty state", async () => {
    const api = createMockEngagementApi({
      getSummary: vi.fn(async () => envelope({ like_count: 0, liked: false, comment_count: 0 })),
      listComments: vi.fn(async () => envelope({ results: [], pagination: { page: 1, has_next: false, total: 0 } })),
    });
    const view = await renderEngagement({ api });
    expect(view.text()).toContain("Be the first to comment.");
    expect(textOf(likeButton(view))).toBe("Like");
  });

  it("loads more comments", async () => {
    const api = createMockEngagementApi();
    const view = await renderEngagement({ api });
    expect(view.text()).not.toContain("Third comment");
    await fire(view.getByLabel("button", "Load more comments"), "onClick");
    await flush();
    expect(view.text()).toContain("Third comment");
    expect(view.find((node) => node.type === "button" && textOf(node) === "Load more comments")).toBeNull();
  });
});

describe("Signed-out viewers", () => {
  it("see a sign-in prompt instead of like/comment controls, and nothing is requested", async () => {
    const api = createMockEngagementApi();
    const view = await renderEngagement({ api, isAuthenticated: false });
    expect(view.text()).toContain("Sign in to like and comment");
    expect(likeButton(view)).toBeNull();
    expect(view.find((node) => node.type === "textarea")).toBeNull();
    expect(api.getSummary).not.toHaveBeenCalled();
    expect(api.listComments).not.toHaveBeenCalled();
    const signIn = view.all((node) => node.type === "a" && node.props.href === "/login");
    expect(signIn.length).toBeGreaterThan(0);
  });
});

describe("Course outline", () => {
  it("navigates between lessons and collapses modules", async () => {
    const onSelect = vi.fn();
    const outline = buildCourseOutline(makeCourse(), { currentLectureId: 12 });
    const view = await renderTree(
      <MemoryRouter>
        <CourseOutline outline={outline} courseId={29} courseTitle="OSINT Professional" currentLectureId={12} onSelect={onSelect} />
      </MemoryRouter>
    );

    const current = view.find((node) => node.props?.["aria-current"] === "true");
    expect(textOf(current)).toContain("Search operators");
    expect(textOf(current)).toContain("Now playing");

    const toggles = view.all((node) => node.type === "button" && node.props["aria-expanded"] !== undefined);
    expect(toggles.map((node) => node.props["aria-expanded"])).toEqual(["true", "false"]);
    expect(textOf(toggles[0])).toContain("1/2");
    expect(textOf(toggles[0])).toContain("1 of 2 lessons completed");

    await fire(toggles[1], "onClick");
    expect(toggles[1].props["aria-expanded"]).toBe("true");

    await fire(view.getByLabel("button", "Maps"), "onClick");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 21, section_title: "Recon" }));

    await fire(toggles[0], "onClick");
    expect(toggles[0].props["aria-expanded"]).toBe("false");
    expect(view.find((node) => node.props?.id === "cp-module-panel-1").props.hidden).toBe(true);
  });

  it("shows locks and the course progress", () => {
    const outline = buildCourseOutline(makeCourse({ is_enrolled: false }), { currentLectureId: 11 });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CourseOutline outline={outline} courseId={29} currentLectureId={11} />
      </MemoryRouter>
    );
    expect(html).toContain("Locked");
    expect(html).toContain("Preview");
    expect(html).toContain("1 of 4 lessons completed");
    expect(html).toContain('href="/courses/29/live"');
  });
});

describe("No view counts", () => {
  it("never renders a view count, even when the API sends one", () => {
    const course = makeCourse();
    course.sections[0].lectures[1].view_count = 4321;
    course.sections[0].lectures[1].views = 4321;
    const lecture = flattenCourseLectures(course)[1];
    const engagement = {
      summaryStatus: "ready",
      commentsStatus: "ready",
      likeCount: 12,
      liked: false,
      commentCount: 1,
      view_count: 4321,
      comments: [makeComment()],
      hasMore: false,
      loadingMore: false,
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LessonHeader lecture={lecture} position={2} total={4} fullAccess />
        <LessonActions engagement={engagement} isAuthenticated previousLecture={null} nextLecture={null} completed={false} />
        <CourseOutline outline={buildCourseOutline(course, { currentLectureId: 12 })} courseId={29} currentLectureId={12} />
        <OverviewPanel lecture={lecture} descriptions={resolveLectureDescriptions(lecture, course)} progress={lecture.progress} />
        <CommentsPanel engagement={engagement} isAuthenticated author={AUTHOR} now={NOW} />
      </MemoryRouter>
    );
    expect(html).not.toContain("4321");
    expect(html).not.toContain("4.3K");
    expect(html).not.toMatch(/\bviews?\b/i);
    // Sanity: the like count is shown.
    expect(html).toContain(">12<");
  });
});
