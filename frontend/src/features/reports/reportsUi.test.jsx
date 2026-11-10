import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { act, fire, renderTree, textOf } from "../../test-utils/renderTree";

// Carbon's Modal needs a real DOM; a plain stand-in keeps the same props contract.
vi.mock("@carbon/react", async (importOriginal) => {
  const actual = await importOriginal();
  const Modal = ({ open, modalHeading, primaryButtonText, secondaryButtonText, onRequestSubmit, onRequestClose, children }) =>
    open ? (
      <div role="dialog" aria-label={modalHeading}>
        <h2>{modalHeading}</h2>
        {children}
        <button type="button" onClick={onRequestClose}>
          {secondaryButtonText}
        </button>
        <button type="button" onClick={onRequestSubmit}>
          {primaryButtonText}
        </button>
      </div>
    ) : null;
  // Icon-only buttons wrap a Tooltip whose DOM checks need a real browser.
  const Button = ({ hasIconOnly, iconDescription, renderIcon: _icon, tooltipPosition: _position, kind: _kind, size: _size, ...rest }) =>
    hasIconOnly ? <button type="button" aria-label={iconDescription} {...rest} /> : <actual.Button kind={_kind} size={_size} renderIcon={_icon} {...rest} />;
  // Carbon checks notification children against the real DOM (focusability).
  const InlineNotification = ({ title, subtitle, children, role }) => (
    <div role={role || "status"}>
      {title} {subtitle}
      {children}
    </div>
  );
  const ContentSwitcher = ({ children, onChange }) => (
    <div role="tablist">
      {[].concat(children).map((child) => (
        <button key={child.props.name} type="button" onClick={() => onChange({ name: child.props.name })}>
          {child.props.text}
        </button>
      ))}
    </div>
  );
  return { ...actual, Modal, Button, InlineNotification, ContentSwitcher };
});

vi.mock("./reportsApi", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    submitReport: vi.fn(),
    uploadReportFile: vi.fn(),
    removeReportUpload: vi.fn(() => Promise.resolve({})),
    fetchReportFileText: vi.fn(() => Promise.resolve({ data: "" })),
  };
});

import { classSummary, GradebookTable } from "../../pages/ReportsGradebookPage";
import { ReportsListView } from "../../pages/ReportsPage";
import { ReportTaskView } from "../../pages/ReportsTaskPage";
import CanvasPreview from "./CanvasPreview";
import GradingForm, { buildGradePayload, initialGradingValues } from "./GradingForm";
import Markdown from "./markdown";
import MarksTrendChart from "./MarksTrendChart";
import { ReportUploaderView } from "./ReportUploader";
import { submitReport } from "./reportsApi";
import StatusChip from "./StatusChip";

const NOW = Date.parse("2026-11-10T06:30:00Z");

beforeAll(() => {
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" });
  vi.stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    scrollY: 0,
    scrollTo() {},
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  for (const name of ["HTMLButtonElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLAnchorElement"]) {
    vi.stubGlobal(name, class {});
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const baseTask = (overrides = {}) => ({
  id: 7,
  course: { id: 29, title: "OSINT Professional Training Program" },
  section: null,
  week_number: 3,
  title: "Trace the owner of example-shop.in",
  opens_at: null,
  due_at: "2026-11-14T18:29:00Z",
  late_policy: "allow_late",
  late_until: "2026-11-15T18:29:00Z",
  accepting_until: "2026-11-15T18:29:00Z",
  window: "open",
  task_status: "published",
  max_marks: "10.00",
  marks_visibility: "on_grade",
  status: "not_submitted",
  is_late: false,
  minutes_late: 0,
  submitted_at: null,
  version_count: 0,
  marks_visible: false,
  final_marks: null,
  can_submit: true,
  brief: "## Scope\nFind the **registrant**.",
  late_penalty_percent_per_day: "10.00",
  allowed_extensions: ["pdf", "pptx", "md", "canvas"],
  max_files: 5,
  max_file_size_mb: 50,
  max_total_size_mb: 200,
  criteria: [],
  attachments: [],
  lock_reason: "",
  submission: null,
  staged_files: [],
  grade: null,
  revision_feedback: "",
  marks_hidden_until_release: false,
  ...overrides,
});

const stored = (id, name, extra = {}) => ({
  id,
  name,
  extension: name.split(".").pop(),
  content_type: "application/pdf",
  size: 2048,
  created_at: "2026-11-10T05:00:00Z",
  preview: "pdf",
  download_url: `/api/reports/files/${id}/download/`,
  ...extra,
});

const findAll = (tree, type, label) => tree.all((node) => node.type === type && textOf(node).includes(label));

describe("StatusChip", () => {
  it("always pairs the status with an icon and a text label", () => {
    const html = renderToStaticMarkup(<StatusChip item={{ status: "graded", marks_visible: true, final_marks: "8.50", max_marks: "10.00" }} />);
    expect(html).toContain('data-status="graded"');
    expect(html).toContain("<svg");
    expect(html).toContain("Graded 8.5/10");
    const late = renderToStaticMarkup(<StatusChip item={{ status: "submitted", is_late: true }} />);
    expect(late).toContain("Late");
    expect(late).toContain("rpt-chip--warning");
  });
});

describe("ReportUploaderView", () => {
  const rules = { allowedExtensions: ["pdf", "md"], maxFiles: 3, maxFileSizeMb: 50, maxTotalSizeMb: 200 };

  it("shows per-file progress, errors with retry, and remove buttons", async () => {
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const tree = await renderTree(
      <ReportUploaderView
        rules={rules}
        items={[
          { key: "a", origin: "staged", id: 1, name: "report.pdf", size: 2048, extension: "pdf", status: "done", progress: 1 },
          { key: "b", origin: "local", name: "notes.md", size: 1024, extension: "md", status: "uploading", progress: 0.42, file: {} },
          { key: "c", origin: "local", name: "graph.md", size: 1024, extension: "md", status: "error", error: "Network error", file: {} },
        ]}
        onRetry={onRetry}
        onRemove={onRemove}
      />
    );
    expect(tree.text()).toContain("Uploaded");
    expect(tree.text()).toContain("Uploading… 42%");
    const bar = tree.find((node) => node.props?.role === "progressbar");
    expect(bar.props["aria-valuenow"]).toBe(42);
    await fire(tree.getByLabel("button", "Retry"), "onClick");
    expect(onRetry).toHaveBeenCalledWith("c");
    await fire(tree.find((node) => node.type === "button" && String(node.props["aria-label"] || "").includes("Remove report.pdf")) || tree.all((node) => node.type === "button" && textOf(node).includes("Remove report.pdf"))[0], "onClick");
    expect(onRemove).toHaveBeenCalledWith("a");
    expect(tree.text()).toContain("up to 3 files, 50 MB each");
  });

  it("passes picked files on and lists rejected files with the reason", async () => {
    const onPick = vi.fn();
    const tree = await renderTree(
      <ReportUploaderView rules={rules} items={[]} rejections={[{ name: "deck.pptm", reason: "Macro-enabled files aren't accepted." }]} onPick={onPick} />
    );
    expect(tree.text()).toContain("1 file wasn't added");
    expect(tree.text()).toContain("deck.pptm");
    const input = tree.find((node) => node.type === "input" && node.props.type === "file");
    expect(input.props.accept).toBe(".pdf,.md");
    const files = [{ name: "a.pdf", size: 1 }];
    await fire(input, "onChange", { target: { files, value: "x" } });
    expect(onPick).toHaveBeenCalledWith(files);
  });

  it("stops accepting files at the limit", async () => {
    const items = [1, 2, 3].map((id) => ({ key: `k${id}`, origin: "staged", id, name: `${id}.pdf`, size: 1, extension: "pdf", status: "done" }));
    const tree = await renderTree(<ReportUploaderView rules={rules} items={items} onPick={vi.fn()} />);
    expect(tree.text()).toContain("File limit reached (3)");
    expect(tree.find((node) => node.type === "input" && node.props.type === "file").props.disabled).toBe(true);
  });
});

describe("submit flow", () => {
  beforeEach(() => {
    submitReport.mockReset();
  });

  it("confirms the files, submits once with one idempotency key and hands back the receipt", async () => {
    const submitted = baseTask({
      status: "submitted",
      version_count: 1,
      submission: {
        id: 51,
        status: "submitted",
        revision: 2,
        version_count: 1,
        first_submitted_at: "2026-11-10T06:30:00Z",
        submitted_at: "2026-11-10T06:30:00Z",
        is_late: false,
        minutes_late: 0,
        current_version: { id: 90, number: 1, note: "", submitted_at: "2026-11-10T06:30:00Z", is_late: false, minutes_late: 0, is_revision: false, files: [stored(11, "report.pdf")] },
        versions: [],
      },
    });
    let resolve;
    submitReport.mockImplementation(() => new Promise((done) => (resolve = done)));
    const onSubmitted = vi.fn();
    const task = baseTask({ staged_files: [stored(11, "report.pdf"), stored(12, "graph.canvas", { preview: "canvas" })] });
    const tree = await renderTree(
      <MemoryRouter>
        <ReportTaskView task={task} now={NOW} onSubmitted={onSubmitted} />
      </MemoryRouter>
    );
    expect(tree.text()).toContain("2 files ready.");
    await fire(findAll(tree, "button", "Submit report")[0], "onClick");
    expect(tree.text()).toContain("Submit your report?");
    expect(tree.text()).toContain("graph.canvas");
    const confirm = findAll(tree, "button", "Submit report").at(-1);
    await fire(confirm, "onClick");
    await fire(confirm, "onClick");
    expect(submitReport).toHaveBeenCalledTimes(2);
    const [first, second] = submitReport.mock.calls;
    expect(first[0]).toBe(7);
    expect(first[1]).toEqual({ fileIds: [11, 12], note: "" });
    expect(first[2]).toMatch(/^[A-Za-z0-9-]{8,}$/);
    expect(second[2]).toBe(first[2]);
    await act(async () => {
      resolve({ data: { data: { created: true, task: submitted } } });
    });
    expect(onSubmitted).toHaveBeenCalledWith(submitted);
  });

  it("warns before a late submission and shows the receipt with Replace files", async () => {
    const lateTask = baseTask({ window: "late", staged_files: [stored(11, "report.pdf")] });
    const tree = await renderTree(
      <MemoryRouter>
        <ReportTaskView task={lateTask} now={Date.parse("2026-11-15T00:00:00Z")} />
      </MemoryRouter>
    );
    await fire(findAll(tree, "button", "Submit report")[0], "onClick");
    expect(tree.text()).toContain("This report will be marked late.");
    expect(tree.text()).toContain("10% of the marks are taken off per day late.");

    const html = renderToStaticMarkup(
      <StaticRouter location="/reports/tasks/7">
        <ReportTaskView
          now={NOW}
          task={baseTask({
            status: "submitted",
            submission: {
              id: 51,
              status: "submitted",
              revision: 2,
              version_count: 2,
              submitted_at: "2026-11-10T06:30:00Z",
              is_late: false,
              minutes_late: 0,
              current_version: { id: 91, number: 2, note: "Key finding: reused alias", submitted_at: "2026-11-10T06:30:00Z", is_late: false, minutes_late: 0, is_revision: false, files: [stored(13, "final.pdf")] },
              versions: [
                { id: 91, number: 2, note: "", submitted_at: "2026-11-10T06:30:00Z", is_late: false, minutes_late: 0, is_revision: false, files: [stored(13, "final.pdf")] },
                { id: 90, number: 1, note: "", submitted_at: "2026-11-09T06:30:00Z", is_late: false, minutes_late: 0, is_revision: false, files: [stored(11, "draft.pdf")] },
              ],
            },
          })}
        />
      </StaticRouter>
    );
    expect(html).toContain("Receipt R-51-v2");
    expect(html).toContain("Replace files");
    expect(html).toContain("Version history (2)");
    expect(html).toContain("draft.pdf");
  });

  it("shows marks, rubric breakdown and feedback once graded", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/reports/tasks/7">
        <ReportTaskView
          now={NOW}
          task={baseTask({
            status: "graded",
            can_submit: false,
            marks_visible: true,
            final_marks: "7.50",
            grade: {
              raw_marks: "8.50",
              late_penalty: "1.00",
              final_marks: "7.50",
              max_marks: "10.00",
              criteria: [
                { id: 1, name: "Sources", max_marks: "6.00", marks: "5.00" },
                { id: 2, name: "Write-up", max_marks: "4.00", marks: "3.50" },
              ],
              feedback: "Strong pivots.\nCite the archive snapshot.",
              graded_at: "2026-11-16T10:00:00Z",
              annotated_file: null,
            },
          })}
        />
      </StaticRouter>
    );
    expect(html).toContain("Your marks");
    expect(html).toContain("7.5");
    expect(html).toContain("8.5 marked, −1 for late submission");
    expect(html).toContain("Sources");
    expect(html).toContain("3.5/4");
    expect(html).toContain("Strong pivots.");
  });
});

describe("GradingForm", () => {
  const detail = {
    id: 51,
    revision: 5,
    status: "submitted",
    minutes_late: 90,
    student: { id: 3, full_name: "Asha Rao", email: "asha@example.com" },
    current_version: { id: 90, number: 1, minutes_late: 90, files: [] },
    task: {
      max_marks: "10.00",
      late_penalty_percent_per_day: "10.00",
      criteria: [
        { id: 1, name: "Sources", max_marks: "6.00", description: "" },
        { id: 2, name: "Write-up", max_marks: "4.00", description: "" },
      ],
    },
    grade: null,
  };

  it("validates rubric marks and builds the payload with the revision token", () => {
    const missing = buildGradePayload(detail, { criteria: { 1: "5" }, feedback: "" }, "grade");
    expect(missing.valid).toBe(false);
    expect(missing.errors["criteria.2"]).toBe("Enter the marks.");
    const draft = buildGradePayload(detail, { criteria: { 1: "5" }, feedback: "" }, "draft");
    expect(draft).toMatchObject({ valid: true, payload: { action: "draft", expected_revision: 5, criteria_marks: { 1: "5" } } });
    const tooHigh = buildGradePayload(detail, { criteria: { 1: "6.5", 2: "4" } }, "grade");
    expect(tooHigh.errors["criteria.1"]).toBe("Marks can't be more than 6.");
    const back = buildGradePayload(detail, { criteria: {}, feedback: "  " }, "return");
    expect(back.errors.feedback).toBe("Tell the student what to fix before returning the report.");
    expect(initialGradingValues({ status: "returned_for_revision", grade: { revision_feedback: "Add sources", feedback: "x", criteria: [] } }).feedback).toBe("Add sources");
  });

  it("shows the total, the late penalty and final marks, and saves & moves on", async () => {
    const onSubmit = vi.fn();
    const tree = await renderTree(<GradingForm detail={detail} hasNext onSubmit={onSubmit} />);
    const input = (id) => tree.find((node) => node.type === "input" && node.props.id === id);
    await fire(input("rpt-criterion-1"), "onChange", { target: { value: "5" } });
    await fire(input("rpt-criterion-2"), "onChange", { target: { value: "3.5" } });
    expect(tree.text()).toContain("8.5 / 10");
    expect(tree.text()).toContain("−1");
    expect(tree.text()).toContain("7.5 / 10");
    await fire(tree.find((node) => node.type === "textarea"), "onChange", { target: { value: "Good pivots" } });
    await fire(tree.find((node) => node.type === "form"), "onSubmit");
    expect(onSubmit).toHaveBeenCalledWith(
      { action: "grade", expected_revision: 5, feedback: "Good pivots", criteria_marks: { 1: "5", 2: "3.5" } },
      { andNext: true }
    );
  });

  it("refuses invalid marks and explains a concurrent change", async () => {
    const onSubmit = vi.fn();
    const plain = { ...detail, minutes_late: 0, current_version: { ...detail.current_version, minutes_late: 0 }, task: { ...detail.task, criteria: [] } };
    const tree = await renderTree(<GradingForm detail={plain} conflict onSubmit={onSubmit} />);
    expect(tree.text()).toContain("Someone else changed this submission.");
    await fire(tree.find((node) => node.type === "input" && node.props.id === "rpt-marks"), "onChange", { target: { value: "11" } });
    await fire(tree.find((node) => node.type === "form"), "onSubmit");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(tree.text()).toContain("Marks can't be more than 10.");
    await fire(findAll(tree, "button", "Return for revision")[0], "onClick");
    expect(tree.text()).toContain("Tell the student what to fix");
  });
});

describe("previews and charts", () => {
  it("draws an Obsidian canvas as an accessible SVG", () => {
    const html = renderToStaticMarkup(
      <CanvasPreview
        title="map.canvas"
        source={JSON.stringify({
          nodes: [
            { id: "a", type: "text", text: "Alias", x: 0, y: 0, width: 200, height: 80 },
            { id: "b", type: "text", text: "Domain", x: 400, y: 0, width: 200, height: 80 },
          ],
          edges: [{ id: "e", fromNode: "a", toNode: "b", label: "registered" }],
        })}
      />
    );
    expect(html).toContain('role="img"');
    expect(html).toContain("map.canvas: 2 cards and 1 connection.");
    expect(html).toContain("registered");
    expect(html).toContain("Zoom in");
    expect(renderToStaticMarkup(<CanvasPreview source="{oops" />)).toContain("not valid JSON");
  });

  it("renders Markdown without injecting HTML or unsafe links", () => {
    const html = renderToStaticMarkup(<Markdown text={"# Hi\n<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror=alert(1)>"} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
  });

  it("charts marks per week with a table view of the same numbers", async () => {
    const points = [
      { id: 1, label: "W1", title: "Week one", marks: "6", max: "10", percent: 60 },
      { id: 2, label: "W2", title: "Week two", marks: "8.5", max: "10", percent: 85 },
    ];
    const tree = await renderTree(<MarksTrendChart points={points} />);
    const svg = tree.find((node) => node.type === "svg");
    expect(svg.props["aria-label"]).toContain("latest 85% (8.5/10)");
    expect(tree.all((node) => node.type === "circle" && node.props.tabIndex === 0)).toHaveLength(2);
    await fire(tree.all((node) => node.type === "circle" && node.props.tabIndex === 0)[0], "onFocus");
    expect(tree.text()).toContain("6/10 marks");
    await fire(tree.getByLabel("button", "Table view"), "onClick");
    expect(tree.find((node) => node.type === "svg" && node.props.role === "img")).toBeNull();
    expect(tree.text()).toContain("Week two");
    expect(tree.text()).toContain("85%");
  });
});

describe("gradebook", () => {
  const book = {
    course: { id: 29, title: "OSINT" },
    tasks: [
      { id: 1, title: "Week one", week_number: 1, due_at: "2026-11-07T00:00:00Z", max_marks: "10.00", status: "closed" },
      { id: 2, title: "Week two", week_number: 2, due_at: "2026-11-14T00:00:00Z", max_marks: "10.00", status: "published" },
    ],
    rows: [
      {
        student: { id: 3, full_name: "Asha Rao", email: "asha@example.com" },
        cells: [
          { task_id: 1, status: "graded", submission_id: 10, final_marks: "8.50", max_marks: "10.00", is_late: true, minutes_late: 30, is_missing: false },
          { task_id: 2, status: "submitted", submission_id: 11, final_marks: null, max_marks: "10.00", is_late: false, minutes_late: 0, is_missing: false },
        ],
        totals: { total_marks: "8.50", max_marks: "10.00", percentage: "85.00", graded_count: 1, missing_count: 0, late_count: 1, submitted_count: 2 },
      },
      {
        student: { id: 4, full_name: "", email: "ravi@example.com" },
        cells: [
          { task_id: 1, status: "missing", submission_id: null, final_marks: null, max_marks: "10.00", is_late: false, minutes_late: 0, is_missing: true },
          { task_id: 2, status: "not_submitted", submission_id: null, final_marks: null, max_marks: "10.00", is_late: false, minutes_late: 0, is_missing: false },
        ],
        totals: { total_marks: "0.00", max_marks: "0.00", percentage: null, graded_count: 0, missing_count: 1, late_count: 0, submitted_count: 0 },
      },
    ],
  };

  it("shows marks, statuses, missing work and totals per student", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/report-grading/gradebook">
        <GradebookTable book={book} />
      </StaticRouter>
    );
    expect(html).toContain("8.5");
    expect(html).toContain("8.5/10");
    expect(html).toContain("85%");
    expect(html).toContain("Missing");
    expect(html).toContain('href="/report-grading/queue?task=2&amp;submission=11"');
    expect(html).toContain("ravi@example.com");
  });

  it("summarises the class", () => {
    expect(classSummary(book.rows).map((item) => [item.id, item.value])).toEqual([
      ["students", 2],
      ["average", "85%"],
      ["missing", 1],
      ["late", 1],
    ]);
  });
});

describe("student list", () => {
  it("puts this week's target on top with a countdown, then past weeks", () => {
    const html = renderToStaticMarkup(
      <StaticRouter location="/reports">
        <ReportsListView
          now={NOW}
          tasks={[
            baseTask(),
            baseTask({ id: 6, title: "Week two target", week_number: 2, window: "closed", status: "graded", marks_visible: true, final_marks: "8.50", due_at: "2026-11-07T18:29:00Z" }),
          ]}
        />
      </StaticRouter>
    );
    expect(html).toContain("This week&#x27;s target");
    expect(html).toContain("Trace the owner of example-shop.in");
    expect(html).toContain("Due in 4 days 11 h");
    expect(html).toContain("Submit report");
    expect(html).toContain("Past weeks");
    expect(html).toContain("Graded 8.5/10");
  });
});
