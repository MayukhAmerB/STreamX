// Grading (WS-D2): Queue first with its count, keyboard next/previous,
// workspace-scoped links, one primary action per task, scroll cue.
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { act, renderTree } from "../../test-utils/renderTree";
import { GRADING_TABS, gradingTabs } from "./GradingPage";
import { QUEUE_STATUS_OPTIONS, queueFilters, queueKeyTarget } from "./GradingQueue";
import { describeCounts, primaryTaskAction, TaskRow } from "./GradingTasks";
import { scrollCue } from "./useScrollCue";
import { gradingPaths, workspaceRootFor } from "./workspaceRoot";

vi.mock("../reports/reportsApi", async (importOriginal) => ({
  ...(await importOriginal()),
  listGradableCourses: () => Promise.resolve({ data: { data: { results: [] } } }),
  listSubmissions: () => Promise.resolve({ data: { data: { results: [], counts: { awaiting: 0 } } } }),
}));
vi.mock("../../hooks/useAuth", () => ({ useAuth: () => ({ isAdmin: false, isInstructor: true, user: { id: 2, role: "instructor" } }) }));

const neighbours = { previous_id: 4, next_id: 6, next_ungraded_id: 9 };
const key = (keyName, extra = {}) => ({ key: keyName, target: { tagName: "DIV" }, ...extra });

describe("grading queue keyboard", () => {
  it("J / K / U move to the next, previous and next ungraded submission", () => {
    expect(queueKeyTarget(key("j"), neighbours)).toBe(6);
    expect(queueKeyTarget(key("J"), neighbours)).toBe(6);
    expect(queueKeyTarget(key("k"), neighbours)).toBe(4);
    expect(queueKeyTarget(key("u"), neighbours)).toBe(9);
  });

  it("Alt + arrows work even while typing feedback; letters do not", () => {
    const typing = { target: { tagName: "TEXTAREA" } };
    expect(queueKeyTarget(key("j", typing), neighbours)).toBeNull();
    expect(queueKeyTarget(key("ArrowRight", { ...typing, altKey: true }), neighbours)).toBe(6);
    expect(queueKeyTarget(key("ArrowLeft", { ...typing, altKey: true }), neighbours)).toBe(4);
  });

  it("ignores other keys, browser shortcuts and the ends of the queue", () => {
    expect(queueKeyTarget(key("x"), neighbours)).toBeNull();
    expect(queueKeyTarget(key("j", { ctrlKey: true }), neighbours)).toBeNull();
    expect(queueKeyTarget(key("j"), { previous_id: 4, next_id: null })).toBeNull();
    expect(queueKeyTarget(key("j"), null)).toBeNull();
  });
});

describe("grading queue filters", () => {
  it("opens on what needs marking, grouped by week", () => {
    expect(queueFilters(new URLSearchParams(""))).toEqual({ status: "awaiting", group: "week" });
    expect(QUEUE_STATUS_OPTIONS[0]).toEqual({ value: "awaiting", label: "To grade" });
  });

  it("'All' drops the status filter; other params pass through", () => {
    expect(queueFilters(new URLSearchParams("status=all&course=3&q=acme&group=off"))).toEqual({ course: "3", q: "acme" });
    expect(queueFilters(new URLSearchParams("status=graded&task=7&late=1"))).toEqual({ task: "7", late: "1", status: "graded", group: "week" });
  });
});

describe("grading tabs and links", () => {
  it("puts Queue first with its count, then Tasks, Marks and Settings", () => {
    expect(GRADING_TABS.map((tab) => tab.label)).toEqual(["Queue", "Tasks", "Marks", "Settings"]);
    const tabs = gradingTabs(gradingPaths("/console/teach"), { course: "5", count: 12 });
    expect(tabs[0]).toMatchObject({ key: "queue", badge: 12, href: "/console/teach/grading/queue?course=5" });
    expect(tabs[1].badge).toBeUndefined();
    expect(gradingTabs(gradingPaths("/console/admin"), { count: 0 })[0].badge).toBeUndefined();
  });

  it("keeps every link inside the viewer's workspace", () => {
    expect(workspaceRootFor("/console/admin/grading/queue")).toBe("/console/admin");
    expect(workspaceRootFor("/console/teach/exams/x", { isAdmin: true })).toBe("/console/teach");
    expect(workspaceRootFor("/console/exams", { isAdmin: true })).toBe("/console/admin");
    expect(workspaceRootFor("/report-grading")).toBe("/console/teach");
    const paths = gradingPaths("/console/admin");
    expect(paths.queue({ task: 3, status: "", submission: 9 })).toBe("/console/admin/grading/queue?task=3&submission=9");
    expect(paths.editTask(14)).toBe("/console/admin/grading/tasks/14/edit");
    expect(paths.newTask({ course: 2 })).toBe("/console/admin/grading/tasks/new?course=2");
    expect(paths.student(7)).toBe("/console/admin/grading/students/7");
  });
});

describe("grading tasks", () => {
  const task = (overrides = {}) => ({
    id: 11,
    course: 2,
    title: "Trace example-shop.in",
    status: "published",
    week_number: 3,
    due_at: "2026-11-15T18:29:00Z",
    max_marks: "10.00",
    criteria: [],
    marks_visibility: "on_grade",
    counts: { students: 30, submitted: 12, awaiting: 5, graded: 7, returned: 0, late: 2 },
    ...overrides,
  });

  it("leads with exactly one action: Publish, Mark n or Submissions", () => {
    expect(primaryTaskAction(task({ status: "draft" }))).toEqual({ kind: "publish", label: "Publish" });
    expect(primaryTaskAction(task())).toEqual({ kind: "mark", label: "Mark 5" });
    expect(primaryTaskAction(task({ counts: { submitted: 3, awaiting: 0 } }))).toEqual({ kind: "submissions", label: "Submissions" });
  });

  it("describes counts with or without a class size", () => {
    expect(describeCounts(task().counts)).toBe("12/30 submitted · 5 to mark · 7 marked · 2 late");
    expect(describeCounts({ submitted: 4, awaiting: 4 })).toBe("4 submitted · 4 to mark");
  });

  it("renders the row with its title link and the queue link in the workspace", () => {
    const markup = renderToStaticMarkup(
      <StaticRouter location="/console/teach/grading/tasks">
        <ul>
          <TaskRow task={task()} paths={gradingPaths("/console/teach")} busy={false} onAction={() => {}} />
        </ul>
      </StaticRouter>
    );
    expect(markup).toContain('href="/console/teach/grading/tasks/11/edit"');
    expect(markup).toContain('href="/console/teach/grading/queue?task=11&amp;course=2"');
    expect(markup).toContain("Mark 5");
    expect(markup).toContain("12/30 submitted");
  });
});

describe("scroll cue", () => {
  it("fades the hidden side only when the table overflows", () => {
    expect(scrollCue({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toBe("");
    expect(scrollCue({ scrollLeft: 0, scrollWidth: 1200, clientWidth: 800 })).toBe("end");
    expect(scrollCue({ scrollLeft: 400, scrollWidth: 1200, clientWidth: 800 })).toBe("start");
  });
});

describe("grading page", () => {
  it("shows a not-found state for an unknown tab, never a retry", async () => {
    const { default: GradingPage } = await import("./GradingPage");
    const { Route, Routes } = await import("react-router-dom");
    let tree;
    await act(async () => {
      tree = await renderTree(
        <MemoryRouter initialEntries={["/console/teach/grading/nope"]}>
          <Routes>
            <Route path="/console/teach/grading/:tab" element={<GradingPage />} />
          </Routes>
        </MemoryRouter>
      );
    });
    expect(tree.text()).toContain("This grading page does not exist");
    expect(tree.text()).toContain("Back to Grading");
    expect(tree.text()).not.toContain("Try again");
    await tree.unmount();
  });
});
