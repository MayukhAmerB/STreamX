// WS-G: Admin workspace units (plan §7.5): attention zero-collapse and the
// single champagne action, the Requests bulk bar + M21 + Undo toast, and the
// Recordings review panel deep link (?open=).
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import attentionFixture from "../../__contracts__/ui-overhaul/attention.json";
import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";
import { ToastProvider } from "../app-shell/ui";
import AdminRecordingsPage from "./AdminRecordingsPage";
import AdminRequestsPage from "./AdminRequestsPage";
import { actionLabel, busiestKey, changedKeys, clearLine, splitQueues, summaryLine } from "./attentionModel";
import AttentionTiles from "./AttentionTiles";
import { shortAge } from "./format";

const api = vi.hoisted(() => ({
  fetchRequests: vi.fn(),
  actOnRequests: vi.fn(),
  fetchRecordings: vi.fn(),
  fetchRecording: vi.fn(),
  actOnRecording: vi.fn(),
}));
vi.mock("./api", () => api);

function fakeBrowser() {
  const win = new EventTarget();
  Object.assign(win, {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    matchMedia: (query) => ({ matches: /reduce/.test(query), addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("window", win);
  // Carbon's Search checks `instanceof HTMLButtonElement`; host stubs never are.
  for (const name of ["HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node"]) {
    if (typeof globalThis[name] === "undefined") vi.stubGlobal(name, class {});
  }
  vi.stubGlobal("document", {
    activeElement: null,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    documentElement: { dataset: {} },
  });
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 5)));

describe("attention model", () => {
  const busy = attentionFixture.busy.queues;

  it("splits waiting queues from zero ones and hides queues the viewer may not see", () => {
    const queues = [...busy.slice(0, 4), { ...busy[4], count: null }];
    const { waiting, clear } = splitQueues(queues);
    expect(waiting.map((queue) => queue.key)).toEqual(["enrolment_requests", "reports_to_grade", "recordings_to_review"]);
    expect(clear.map((queue) => queue.key)).toEqual(["uploads_failed"]);
    expect(clearLine(clear)).toBe("All clear: uploads.");
  });

  it("picks the busiest queue once and words the summary", () => {
    expect(busiestKey(busy)).toBe("reports_to_grade");
    expect(busiestKey(attentionFixture.all_clear.queues)).toBeNull();
    expect(summaryLine(splitQueues(busy).waiting)).toBe("3 things need you");
    expect(summaryLine([busy[0]])).toBe("1 thing needs you");
    expect(summaryLine([])).toBe("Nothing needs you right now");
    expect(actionLabel(busy[0])).toBe("Review 4");
  });

  it("notices counts that grew between polls", () => {
    const next = busy.map((queue) => (queue.key === "enrolment_requests" ? { ...queue, count: 5 } : queue));
    expect(changedKeys(busy, next)).toEqual(["enrolment_requests"]);
  });

  it("formats ages briefly", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    expect(shortAge("2026-11-12T12:00:00Z", now)).toBe("2 d");
    expect(shortAge("2026-11-14T07:00:00Z", now)).toBe("5 h");
    expect(shortAge("2026-11-14T11:59:30Z", now)).toBe("just now");
  });
});

describe("AttentionTiles", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders one tile per waiting queue, one champagne action, and one All clear line", async () => {
    fakeBrowser();
    const tree = await renderTree(
      <MemoryRouter>
        <AttentionTiles queues={attentionFixture.busy.queues} now={new Date("2026-11-14T18:04:00+05:30")} />
      </MemoryRouter>
    );
    const tiles = tree.all((node) => node.type === "li" && node.props["data-queue"]);
    expect(tiles.map((tile) => tile.props["data-queue"])).toEqual(["enrolment_requests", "reports_to_grade", "recordings_to_review"]);
    const accents = tree.all((node) => String(node.props?.className || "").includes("adm-button--accent"));
    expect(accents).toHaveLength(1);
    expect(textOf(accents[0])).toBe("Open queue 12");
    const line = tree.find((node) => node.props?.["data-testid"] === "attention-all-clear");
    expect(textOf(line)).toBe("All clear: uploads, payments, exams, leads, questions, files, system and prices.");
    // Back-office queues are full page loads; Console queues stay in the app.
    expect(tree.find((node) => node.type === "a" && node.props.href === "/console/admin/requests")).not.toBeNull();
    await tree.unmount();
  });

  it("collapses everything into one calm line when nothing waits", async () => {
    fakeBrowser();
    const tree = await renderTree(
      <MemoryRouter>
        <AttentionTiles queues={attentionFixture.all_clear.queues} />
      </MemoryRouter>
    );
    expect(tree.all((node) => node.type === "li" && node.props["data-queue"])).toHaveLength(0);
    expect(textOf(tree.find((node) => node.props?.["data-testid"] === "attention-all-clear"))).toMatch(/^Everything is up to date\. All clear: requests, grading/);
    await tree.unmount();
  });
});

describe("hackpath: plans waiting for a price, launch gates and switch copy", () => {
  afterEach(() => vi.unstubAllGlobals());
  const pending = { ...attentionFixture.busy.queues.at(-1), count: 3 };

  it("shows the plans queue as a tile with its own action when plans wait (N-state)", async () => {
    fakeBrowser();
    const queues = attentionFixture.all_clear.queues.map((queue) => (queue.key === "plans_awaiting_price" ? pending : queue));
    const tree = await renderTree(
      <MemoryRouter>
        <AttentionTiles queues={queues} />
      </MemoryRouter>
    );
    const tiles = tree.all((node) => node.type === "li" && node.props["data-queue"]);
    expect(tiles.map((tile) => tile.props["data-queue"])).toEqual(["plans_awaiting_price"]);
    expect(textOf(tiles[0])).toContain("Plans waiting for price confirmation");
    expect(tree.find((node) => node.type === "a" && node.props.href === "/admin/payments/platformplan/")).not.toBeNull();
    expect(textOf(tree.find((node) => String(node.props?.className || "").includes("adm-button--accent")))).toBe("Confirm prices 3");
    await tree.unmount();
  });

  it("folds the plans queue into the All clear line at zero (0-state)", () => {
    expect(clearLine(splitQueues(attentionFixture.all_clear.queues).clear)).toMatch(/system and prices\.$/);
  });

  it("explains each launch gate on the admin home in words, never hue", async () => {
    const { SWITCH_NOTES } = await import("./AdminHomePage");
    expect(SWITCH_NOTES.pentesting.off).toMatch(/Coming soon/);
    expect(SWITCH_NOTES.memberships.off).toMatch(/No new subscriptions/);
    expect(SWITCH_NOTES.labs_membership_required.off).toMatch(/open/);
  });

  it("words the saved line per switch and falls back for unknown switches", async () => {
    const { savedSentence } = await import("./AdminFeaturesPage");
    expect(savedSentence({ key: "teaching", label: "Teachers section" }, true)).toBe("Teachers section is on. Instructors will see it within seconds.");
    expect(savedSentence({ key: "pentesting", label: "Pentesting section" }, false)).toBe("Pentesting section is off. Pentesting shows “Coming soon” within seconds.");
    expect(savedSentence({ key: "brand_new", label: "Brand new" }, true)).toMatch(/^Brand new is on\. /);
  });
});

const requestRows = [
  {
    id: "course_1",
    pk: 1,
    kind: "course",
    kind_label: "Course access",
    status: "pending",
    requested_at: "2026-11-12T09:30:00+05:30",
    student: { id: 7, name: "Sana Student", email: "sana@example.com", phone: "" },
    target: { id: 3, title: "OSINT Foundations" },
    can_change: true,
    back_office_href: "/admin/courses/enrollment/1/change/",
  },
  {
    id: "live_class_2",
    pk: 2,
    kind: "live_class",
    kind_label: "Live class",
    status: "pending",
    requested_at: "2026-11-13T09:30:00+05:30",
    student: { id: 8, name: "Bilal Student", email: "bilal@example.com", phone: "" },
    target: { id: 4, title: "OSINT Batch IV" },
    can_change: true,
    back_office_href: "/admin/courses/liveclassenrollment/2/change/",
  },
];

function requestsPayload(rows = requestRows) {
  return {
    data: {
      data: {
        results: rows,
        count: rows.length,
        counts: { pending: rows.length, approved: 0, rejected: 0 },
        kinds: [
          { key: "course", label: "Course access" },
          { key: "live_class", label: "Live class" },
        ],
      },
    },
  };
}

describe("AdminRequestsPage", () => {
  beforeEach(() => {
    fakeBrowser();
    Object.values(api).forEach((fn) => fn.mockReset());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("selecting rows shows the bulk bar; approving fades the rows out and offers Undo", async () => {
    api.fetchRequests.mockResolvedValue(requestsPayload());
    api.actOnRequests.mockResolvedValue({
      data: { data: { action: "approve", changed: 2, results: requestRows.map((row) => ({ id: row.id, status: "approved", changed: true })) } },
    });
    const tree = await renderTree(
      <ToastProvider>
        <MemoryRouter initialEntries={["/console/admin/requests"]}>
          <AdminRequestsPage />
        </MemoryRouter>
      </ToastProvider>
    );
    await flush();
    expect(tree.all((node) => node.type === "li" && node.props["data-request"])).toHaveLength(2);
    expect(tree.find((node) => node.props?.["aria-label"] === "Bulk actions")).toBeNull();

    const boxes = tree.all((node) => node.type === "input" && String(node.props["aria-label"] || "").startsWith("Select "));
    await fire(boxes[1], "onChange");
    await fire(boxes[2], "onChange");
    const bar = tree.find((node) => node.props?.["aria-label"] === "Bulk actions");
    expect(textOf(bar)).toContain("2 selected");
    const approve = tree.find((node) => node.type === "button" && textOf(node) === "Approve 2");
    api.fetchRequests.mockResolvedValue(requestsPayload([])); // the quiet refetch after the change
    await fire(approve, "onClick");
    await flush();
    expect(api.actOnRequests).toHaveBeenCalledWith(["course_1", "live_class_2"], "approve");
    expect(tree.all((node) => node.type === "li" && node.props["data-request"])).toHaveLength(0);
    expect(tree.text()).toContain("Approved");
    const undo = tree.find((node) => node.type === "button" && textOf(node) === "Undo");
    expect(undo).not.toBeNull();
    api.actOnRequests.mockResolvedValue({ data: { data: { action: "reopen", changed: 2, results: [] } } });
    await fire(undo, "onClick");
    await flush();
    expect(api.actOnRequests).toHaveBeenLastCalledWith(["course_1", "live_class_2"], "reopen");
    await tree.unmount();
  });

  it("approves one row inline", async () => {
    api.fetchRequests.mockResolvedValue(requestsPayload());
    api.actOnRequests.mockResolvedValue({ data: { data: { changed: 1, results: [{ id: "course_1", status: "approved", changed: true }] } } });
    const tree = await renderTree(
      <ToastProvider>
        <MemoryRouter initialEntries={["/console/admin/requests"]}>
          <AdminRequestsPage />
        </MemoryRouter>
      </ToastProvider>
    );
    await flush();
    api.fetchRequests.mockResolvedValue(requestsPayload([requestRows[1]]));
    await fire(tree.getByLabel("button", "Approve Sana Student"), "onClick");
    await flush();
    expect(api.actOnRequests).toHaveBeenCalledWith(["course_1"], "approve");
    expect(tree.all((node) => node.type === "li" && node.props["data-request"]).map((node) => node.props["data-request"])).toEqual(["live_class_2"]);
    await tree.unmount();
  });
});

describe("AdminRecordingsPage", () => {
  beforeEach(() => {
    fakeBrowser();
    Object.values(api).forEach((fn) => fn.mockReset());
  });
  afterEach(() => vi.unstubAllGlobals());

  const item = {
    id: "cr_5",
    source: "class_recording",
    source_label: "Class recording",
    title: "Recon class - 10 Nov",
    subtitle: "OSINT Foundations · Class recordings",
    status: "published",
    state_label: "Published",
    needs_review: true,
    review_reason: "Module chosen automatically.",
    error: "",
    created_at: "2026-11-14T10:00:00Z",
    facts: [{ label: "Source", value: "Server recording" }],
    actions: { publish: false, unpublish: true, mark_reviewed: true, retry: false },
    links: { back_office: "/admin/realtime/classrecording/5/change/", course: "" },
    media_url: "",
  };

  function Where() {
    const location = useLocation();
    return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
  }

  it("opens the review panel from the ?open= deep link and runs an action", async () => {
    api.fetchRecordings.mockResolvedValue({ data: { data: { results: [item], count: 1, counts: { needs_review: 1, failed: 0, processing: 0, published: 1 } } } });
    api.fetchRecording.mockResolvedValue({ data: { data: item } });
    api.actOnRecording.mockResolvedValue({ data: { data: { message: "Marked as reviewed.", item: { ...item, needs_review: false, actions: { ...item.actions, mark_reviewed: false } } } } });
    const tree = await renderTree(
      <ToastProvider>
        <MemoryRouter initialEntries={["/console/admin/recordings?filter=needs_review&open=cr_5"]}>
          <AdminRecordingsPage />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    );
    await flush();
    expect(api.fetchRecordings).toHaveBeenCalledWith({ filter: "needs_review" });
    expect(api.fetchRecording).toHaveBeenCalledWith("cr_5");
    const panel = tree.find((node) => node.type === "aside" && node.props.role === "dialog");
    expect(panel).not.toBeNull();
    expect(textOf(panel)).toContain("Module chosen automatically.");
    const button = tree.find((node) => node.type === "button" && textOf(node) === "Mark reviewed");
    expect(String(button.props.className)).toContain("adm-button--primary");
    await fire(button, "onClick");
    await flush();
    expect(api.actOnRecording).toHaveBeenCalledWith("cr_5", "mark_reviewed");
    expect(tree.text()).toContain("Marked as reviewed.");

    // Closing the panel drops ?open= and keeps the filter.
    await fire(tree.getByLabel("button", "Close panel"), "onClick");
    await flush();
    expect(textOf(tree.find((node) => node.props?.["data-testid"] === "where"))).toBe("/console/admin/recordings?filter=needs_review");
    await tree.unmount();
  });

  it("a row click sets ?open=<id>", async () => {
    api.fetchRecordings.mockResolvedValue({ data: { data: { results: [item], count: 1, counts: {} } } });
    api.fetchRecording.mockResolvedValue({ data: { data: item } });
    const tree = await renderTree(
      <ToastProvider>
        <MemoryRouter initialEntries={["/console/admin/recordings"]}>
          <AdminRecordingsPage />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    );
    await flush();
    await fire(tree.getByLabel("button", "Review Recon class"), "onClick");
    await flush();
    expect(textOf(tree.find((node) => node.props?.["data-testid"] === "where"))).toBe("/console/admin/recordings?open=cr_5");
    expect(api.fetchRecording).toHaveBeenCalledWith("cr_5");
    await tree.unmount();
  });
});
