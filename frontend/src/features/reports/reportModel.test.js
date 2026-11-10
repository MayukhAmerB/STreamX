import { describe, expect, it } from "vitest";

import { edgePath, facingSide, initialViewBox, parseCanvas, plainCardText, wrapText, zoomViewBox } from "./canvasModel";
import { parseInline, parseMarkdown } from "./markdown";
import {
  describeLatePolicy,
  formatDuration,
  formatIst,
  formatMarks,
  fromIstInputValue,
  getCountdown,
  getStatusChip,
  getTrendPoints,
  latePenalty,
  receiptId,
  rubricTotal,
  splitTasks,
  summarizeMarks,
  toHundredths,
  toIstInputValue,
  validateMarksInput,
  validatePickedFiles,
} from "./reportModel";
import { copyFromPreviousTask, emptyTaskForm, formToPayload, rubricSum, validateTaskForm } from "./taskForm";

const MB = 1024 * 1024;
const file = (name, size = 1000) => ({ name, size });

describe("validatePickedFiles (uploader checks before upload)", () => {
  const rules = { allowedExtensions: ["pdf", "pptx", "md", "canvas", "zip"], maxFiles: 3, maxFileSizeMb: 2, maxTotalSizeMb: 3 };

  it("accepts allowed types and explains every rejection", () => {
    const { accepted, rejected } = validatePickedFiles(
      [file("report.pdf"), file("deck.pptm"), file("notes.exe"), file("empty.md", 0), file("big.pdf", 3 * MB), file("README")],
      rules
    );
    expect(accepted.map((item) => item.name)).toEqual(["report.pdf"]);
    expect(rejected.map((item) => [item.name, item.reason])).toEqual([
      ["deck.pptm", "Macro-enabled files aren't accepted. Save it as .pptx or .docx."],
      ["notes.exe", ".exe files aren't accepted for this report."],
      ["empty.md", "This file is empty."],
      ["big.pdf", "Larger than the 2.0 MB limit per file."],
      ["README", "Files need an extension, such as .pdf."],
    ]);
  });

  it("enforces the file count, the total size and duplicates, counting files already listed", () => {
    const existing = [{ name: "a.pdf", size: 1.5 * MB }];
    const { accepted, rejected } = validatePickedFiles(
      [file("a.pdf", 1.5 * MB), file("b.md", MB), file("c.canvas", MB), file("d.zip", 10), file("e.pdf", 10)],
      rules,
      existing
    );
    expect(accepted.map((item) => item.name)).toEqual(["b.md", "d.zip"]);
    expect(rejected.map((item) => item.reason)).toEqual([
      "This file is already in the list.",
      "All files together must stay under 3.0 MB.",
      "You can attach up to 3 files.",
    ]);
  });

  it("treats upper-case extensions like lower-case ones and defaults to every type", () => {
    expect(validatePickedFiles([file("GRAPH.PNG"), file("vault.ZIP")], {}).accepted).toHaveLength(2);
  });
});

describe("status chips", () => {
  it("shows marks only when they are visible", () => {
    expect(getStatusChip({ status: "graded", marks_visible: true, final_marks: "8.50", max_marks: "10.00" })).toMatchObject({
      label: "Graded 8.5/10",
      tone: "success",
      icon: "graded",
    });
    expect(getStatusChip({ status: "graded", marks_visible: false, final_marks: null }).label).toBe("Graded · marks soon");
  });

  it("covers every state with an icon and a label", () => {
    const cases = [
      [{ status: "not_submitted", window: "open" }, "Not submitted", "neutral"],
      [{ status: "not_submitted", window: "closed" }, "Not submitted", "error"],
      [{ status: "missing" }, "Not submitted", "error"],
      [{ status: "submitted" }, "Submitted", "accent"],
      [{ status: "submitted", is_late: true }, "Late", "warning"],
      [{ status: "under_review" }, "Under review", "info"],
      [{ status: "returned_for_revision" }, "Returned", "warning"],
      [{ status: "resubmitted" }, "Resubmitted", "accent"],
    ];
    for (const [item, label, tone] of cases) {
      const chip = getStatusChip(item);
      expect([chip.label, chip.tone]).toEqual([label, tone]);
      expect(chip.icon).toBeTruthy();
    }
  });
});

describe("dates in India time", () => {
  it("formats deadlines in IST whatever the device time zone", () => {
    expect(formatIst("2026-11-14T18:29:00Z")).toBe("Sat 14 Nov, 11:59 pm IST");
    expect(formatIst("2026-11-14T03:30:00Z", { withWeekday: false })).toBe("14 Nov, 9:00 am IST");
    expect(formatIst("")).toBe("");
  });

  it("round-trips datetime-local values through the +05:30 offset", () => {
    expect(toIstInputValue("2026-11-14T18:29:00Z")).toBe("2026-11-14T23:59");
    expect(fromIstInputValue("2026-11-14T23:59")).toBe("2026-11-14T23:59:00+05:30");
    expect(new Date(fromIstInputValue("2026-11-14T23:59")).toISOString()).toBe("2026-11-14T18:29:00.000Z");
    expect(fromIstInputValue("14/11/2026")).toBeNull();
  });

  it("counts down with urgency tones and reports passed deadlines", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(getCountdown("2026-11-12T04:00:00Z", now)).toEqual({ text: "Due in 2 days 4 h", tone: "calm" });
    expect(getCountdown("2026-11-10T03:20:00Z", now)).toEqual({ text: "Due in 3 h 20 min", tone: "urgent" });
    expect(getCountdown("2026-11-11T12:00:00Z", now).tone).toBe("soon");
    expect(getCountdown("2026-11-09T22:00:00Z", now)).toEqual({ text: "Deadline passed 2 h ago", tone: "past" });
    expect(formatDuration(30 * 1000)).toBe("less than a minute");
  });
});

describe("marks maths (exact to two decimals)", () => {
  it("parses and formats marks", () => {
    expect(formatMarks("8.50")).toBe("8.5");
    expect(formatMarks("10.00")).toBe("10");
    expect(formatMarks(null)).toBe("");
    expect(toHundredths("7.05")).toBe(705);
    expect(toHundredths("7.055")).toBeNull();
  });

  it("validates a marks input against the maximum", () => {
    expect(validateMarksInput("", "10.00")).toBe("Enter the marks.");
    expect(validateMarksInput("", "10.00", { required: false })).toBe("");
    expect(validateMarksInput("abc", "10")).toBe("Enter a number, such as 8.5.");
    expect(validateMarksInput("8.555", "10")).toBe("Use at most two decimal places.");
    expect(validateMarksInput("10.01", "10.00")).toBe("Marks can't be more than 10.");
    expect(validateMarksInput("9.99", "10.00")).toBe("");
  });

  it("applies the late penalty like the server (per started day, capped at the marks)", () => {
    expect(latePenalty({ rawMarks: "8", maxMarks: "10", minutesLate: 1, percentPerDay: "10" })).toEqual({ penalty: "1", final: "7", days: 1 });
    expect(latePenalty({ rawMarks: "8", maxMarks: "10", minutesLate: 25 * 60, percentPerDay: "10" })).toEqual({ penalty: "2", final: "6", days: 2 });
    expect(latePenalty({ rawMarks: "1.5", maxMarks: "10", minutesLate: 5 * 1440, percentPerDay: "50" })).toEqual({ penalty: "1.5", final: "0", days: 5 });
    expect(latePenalty({ rawMarks: "7.25", maxMarks: "10", minutesLate: 0, percentPerDay: "10" }).final).toBe("7.25");
    expect(latePenalty({ rawMarks: "", maxMarks: "10", minutesLate: 10, percentPerDay: "10" }).final).toBeNull();
  });

  it("totals rubric marks and gradebook cells without floating point drift", () => {
    expect(rubricTotal([{ id: 1 }, { id: 2 }, { id: 3 }], { 1: "0.1", 2: "0.2", 3: "" })).toBe("0.3");
    expect(rubricTotal([{ id: 1 }], {})).toBeNull();
    const totals = summarizeMarks([
      { task_id: 1, final_marks: "8.50", max_marks: "10.00", is_late: false, is_missing: false },
      { task_id: 2, final_marks: "7.25", max_marks: "10.00", is_late: true, is_missing: false },
      { task_id: 3, final_marks: null, max_marks: "10.00", is_late: false, is_missing: true },
      { task_id: 4, final_marks: null, max_marks: "5.00", is_late: false, is_missing: false },
    ]);
    expect(totals).toEqual({ total: "15.75", outOf: "20", percentage: 78.75, graded: 2, missing: 1, late: 1 });
    expect(summarizeMarks([]).percentage).toBeNull();
  });

  it("builds trend points for graded weeks in due order", () => {
    const tasks = [
      { id: 2, title: "Week two", week_number: 2, due_at: "2026-11-14T00:00:00Z", max_marks: "10.00" },
      { id: 1, title: "Week one", week_number: 1, due_at: "2026-11-07T00:00:00Z", max_marks: "10.00" },
      { id: 3, title: "Week three", week_number: 3, due_at: "2026-11-21T00:00:00Z", max_marks: "8.00" },
    ];
    const cells = [
      { task_id: 1, final_marks: "6.00" },
      { task_id: 2, final_marks: "8.50" },
      { task_id: 3, final_marks: null },
    ];
    expect(getTrendPoints(tasks, cells)).toEqual([
      { id: 1, label: "W1", title: "Week one", marks: "6", max: "10", percent: 60 },
      { id: 2, label: "W2", title: "Week two", marks: "8.5", max: "10", percent: 85 },
    ]);
  });
});

describe("student list", () => {
  it("puts the open task that still needs work first, then other open tasks, then past weeks", () => {
    const tasks = [
      { id: 1, window: "closed", status: "graded", due_at: "2026-11-01T00:00:00Z" },
      { id: 2, window: "open", status: "submitted", due_at: "2026-11-12T00:00:00Z" },
      { id: 3, window: "open", status: "not_submitted", due_at: "2026-11-14T00:00:00Z" },
      { id: 4, window: "closed", status: "not_submitted", due_at: "2026-11-05T00:00:00Z" },
    ];
    const { current, open, past } = splitTasks(tasks);
    expect(current.id).toBe(3);
    expect(open.map((task) => task.id)).toEqual([2]);
    expect(past.map((task) => task.id)).toEqual([4, 1]);
    expect(splitTasks([]).current).toBeNull();
  });

  it("describes the late policy and receipt ids", () => {
    expect(describeLatePolicy({ late_policy: "no_late" })).toBe("Late submissions are not accepted.");
    expect(describeLatePolicy({ late_policy: "allow_late", late_until: "2026-11-15T18:29:00Z", late_penalty_percent_per_day: "10.00" })).toBe(
      "Late reports are accepted until Sun 15 Nov, 11:59 pm IST, with 10% of the marks taken off per day late."
    );
    expect(receiptId({ id: 42, current_version: { number: 3 } })).toBe("R-42-v3");
  });
});

describe("Obsidian canvas parser", () => {
  const canvas = {
    nodes: [
      { id: "a", type: "text", text: "# Target\n**Alias** used on [[Forum]]", x: 0, y: 0, width: 300, height: 120, color: "1" },
      { id: "b", type: "file", file: "Evidence/photo.png", x: 500, y: 40, width: 200, height: 100 },
      { id: "g", type: "group", label: "Phase 1", x: -40, y: -60, width: 800, height: 260, color: "#00ff00" },
      { id: "l", type: "link", url: "https://example.com", x: 0, y: 300, width: "bad", height: null },
      { id: "a", type: "text", text: "duplicate id is ignored", x: 9, y: 9 },
      { type: "text", text: "no id" },
    ],
    edges: [
      { id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", label: "owns", color: "4" },
      { id: "e2", fromNode: "a", toNode: "l" },
      { id: "e3", fromNode: "a", toNode: "missing" },
    ],
  };

  it("normalises nodes, colours, sizes and draws groups first", () => {
    const parsed = parseCanvas(JSON.stringify(canvas));
    expect(parsed.error).toBe("");
    expect(parsed.nodes.map((node) => node.id)).toEqual(["g", "a", "b", "l"]);
    const [group, text, fileNode, link] = parsed.nodes;
    expect(group.color).toBe("#00ff00");
    expect(text.color).toBe("#fb464c");
    expect(text.display).toBe("Target\nAlias used on Forum");
    expect(fileNode.display).toBe("photo.png");
    expect([link.width, link.height]).toEqual([250, 60]);
    expect(parsed.bounds).toEqual({ x: -40, y: -60, width: 800, height: 420 });
  });

  it("connects edges at the given sides, infers missing sides and drops dangling edges", () => {
    const parsed = parseCanvas(canvas);
    expect(parsed.edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);
    const [owns, inferred] = parsed.edges;
    expect(owns.start).toEqual({ x: 300, y: 60 });
    expect(owns.end).toEqual({ x: 500, y: 90 });
    expect(owns.color).toBe("#44cf6e");
    expect(owns.path.startsWith("M 300 60 C")).toBe(true);
    expect([inferred.fromSide, inferred.toSide]).toEqual(["bottom", "top"]);
    expect(inferred.arrowEnd).toBe(true);
  });

  it("reports invalid input without throwing", () => {
    expect(parseCanvas("{not json").error).toBe("This canvas file is not valid JSON.");
    expect(parseCanvas("[1,2]").error).toBe("This file is not an Obsidian canvas.");
    expect(parseCanvas("").nodes).toEqual([]);
    expect(parseCanvas({ nodes: "x", edges: null }).nodes).toEqual([]);
  });

  it("caps very large canvases", () => {
    const nodes = Array.from({ length: 2100 }, (_, index) => ({ id: `n${index}`, x: index, y: 0 }));
    const parsed = parseCanvas({ nodes });
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes).toHaveLength(2000);
  });

  it("helpers: sides, paths, wrapping, viewBox", () => {
    expect(facingSide({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 0, width: 10, height: 10 })).toBe("right");
    expect(facingSide({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: -100, width: 10, height: 10 })).toBe("top");
    expect(edgePath({ x: 0, y: 0 }, "right", { x: 100, y: 0 }, "left")).toBe("M 0 0 C 40 0, 60 0, 100 0");
    expect(wrapText("one two three four five six", 9, 2)).toEqual(["one two", "three…"]);
    expect(plainCardText("- item\n![x](y.png)")).toBe("• item");
    expect(initialViewBox(null)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(zoomViewBox({ x: 0, y: 0, width: 400, height: 200 }, 0.5)).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });
});

describe("safe Markdown", () => {
  it("parses blocks used in briefs and Obsidian notes", () => {
    const blocks = parseMarkdown("---\ntags: osint\n---\n# Target\nFind **the owner**.\n\n- [x] whois\n- [ ] archive\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```");
    expect(blocks.map((block) => block.type)).toEqual(["properties", "heading", "paragraph", "list", "table", "code"]);
    expect(blocks[3].items.map((item) => item.checked)).toEqual([true, false]);
  });

  it("only links http(s)/mailto and never fetches images", () => {
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "x" }, { type: "text", text: ")" }]);
    expect(parseInline("[site](https://example.com)")[0]).toMatchObject({ type: "link", href: "https://example.com" });
    expect(parseInline("![map](https://evil.example/track.png)")[0]).toEqual({ type: "image", alt: "map" });
    expect(parseInline("<script>alert(1)</script>")).toEqual([{ type: "text", text: "<script>alert(1)</script>" }]);
    expect(parseInline("[[Note|Alias]]")[0]).toEqual({ type: "wikilink", text: "Alias" });
  });
});

describe("weekly-target editor form", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const valid = { ...emptyTaskForm("3", "4"), title: "Trace the vendor", due_at: "2026-11-14T23:59" };

  it("accepts a complete form and builds the API payload in IST", () => {
    expect(validateTaskForm(valid, { now })).toEqual({});
    const payload = formToPayload({ ...valid, allowed_file_types: ["pdf", "md"] });
    expect(payload).toMatchObject({
      course: 3,
      week_number: 4,
      due_at: "2026-11-14T23:59:00+05:30",
      late_until: null,
      late_penalty_percent_per_day: "0",
      max_marks: "10",
      allowed_file_types: ["pdf", "md"],
      criteria: [],
    });
  });

  it("flags deadlines, late windows, limits and rubric totals", () => {
    const errors = validateTaskForm(
      {
        ...valid,
        title: " ",
        due_at: "2026-11-01T10:00",
        late_policy: "allow_late",
        late_until: "",
        late_penalty_percent_per_day: "120",
        max_files: "0",
        criteria: [
          { key: "a", name: "Sources", max_marks: "4" },
          { key: "b", name: "", max_marks: "x" },
        ],
      },
      { now }
    );
    expect(Object.keys(errors).sort()).toEqual(
      ["criteria.1.max_marks", "criteria.1.name", "due_at", "late_penalty_percent_per_day", "late_until", "max_files", "title"].sort()
    );
    const rubric = validateTaskForm({ ...valid, criteria: [{ key: "a", name: "A", max_marks: "4" }, { key: "b", name: "B", max_marks: "5.5" }] }, { now });
    expect(rubric.criteria).toBe("The rubric adds up to 9.5 but the report is out of 10.");
    expect(rubricSum([{ max_marks: "4" }, { max_marks: "5.5" }])).toBe("9.5");
  });

  it("duplicates last week with dates one week later and the next week number", () => {
    const form = copyFromPreviousTask({
      course: 3,
      week_number: 4,
      title: "Week 4",
      due_at: "2026-11-14T18:29:00Z",
      opens_at: null,
      late_policy: "allow_late",
      late_until: "2026-11-15T18:29:00Z",
      late_penalty_percent_per_day: "10.00",
      max_marks: "10.00",
      criteria: [{ name: "Sources", description: "", max_marks: "10.00" }],
    });
    expect(form).toMatchObject({ week_number: "5", due_at: "2026-11-21T23:59", late_until: "2026-11-22T23:59", opens_at: "", max_marks: "10" });
    expect(form.criteria[0]).toMatchObject({ name: "Sources", max_marks: "10" });
  });
});
