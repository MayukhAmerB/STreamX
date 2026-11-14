import { describe, expect, it } from "vitest";

import {
  fromIstInput,
  missingMaterials,
  previewLines,
  publishAction,
  readinessSummary,
  scheduleFormFrom,
  schedulePayload,
  scheduleProblem,
  studentExamCard,
  toIstInput,
  uploadProblems,
} from "./examModel";

const NOW = Date.parse("2026-11-14T06:00:00Z");

const readyItems = [
  { id: "pepper", label: "Answer pepper configured", ok: true, detail: "" },
  { id: "answer_key", label: "Answer key matches", ok: true, detail: "" },
  { id: "questions", label: "Questions loaded", ok: true, detail: "3 question(s)." },
  { id: "window", label: "Exam window set", ok: true, detail: "" },
  { id: "batches", label: "Batches chosen", ok: true, detail: "1 batch(es)." },
  { id: "materials", label: "Evidence files uploaded", ok: true, detail: "" },
];

const exam = (overrides = {}) => ({
  slug: "week-5",
  state: "draft",
  can_manage: true,
  opens_at: "2026-11-14T05:00:00Z",
  closes_at: "2026-11-14T09:00:00Z",
  readiness: { ready: true, items: readyItems, reasons: [] },
  ...overrides,
});

describe("IST inputs", () => {
  it("round-trips a wall-clock IST time with an explicit offset", () => {
    expect(toIstInput("2026-11-20T04:00:00Z")).toBe("2026-11-20T09:30");
    expect(fromIstInput("2026-11-20T09:30")).toBe("2026-11-20T09:30:00+05:30");
    expect(Date.parse(fromIstInput(toIstInput("2026-11-20T04:00:00Z")))).toBe(Date.parse("2026-11-20T04:00:00Z"));
    expect(fromIstInput("")).toBeNull();
    expect(fromIstInput("tomorrow")).toBeNull();
    expect(toIstInput(null)).toBe("");
  });
});

describe("publish action (disabled with the reason)", () => {
  it("is enabled only when every readiness item passes", () => {
    expect(publishAction(exam(), NOW)).toMatchObject({ label: "Publish now", disabled: false });
    expect(publishAction(exam({ opens_at: "2026-11-15T05:00:00Z", closes_at: "2026-11-15T09:00:00Z" }), NOW)).toMatchObject({
      label: "Schedule",
      disabled: false,
    });
  });

  it("names the first missing item and how many more", () => {
    const items = readyItems.map((item) =>
      item.id === "pepper"
        ? { ...item, ok: false, detail: "CTF_ANSWER_PEPPER is not set on the server, so answers cannot be checked." }
        : item.id === "batches"
          ? { ...item, ok: false, detail: "Choose at least one batch that may sit the exam." }
          : item
    );
    const action = publishAction(exam({ readiness: { ready: false, items } }), NOW);
    expect(action.disabled).toBe(true);
    expect(action.reason).toBe("CTF_ANSWER_PEPPER is not set on the server, so answers cannot be checked. (+1 more)");
  });

  it("explains every other disabled state", () => {
    expect(publishAction(exam({ can_manage: false }), NOW)).toMatchObject({ disabled: true, reason: "Only staff can publish exams." });
    expect(publishAction(exam({ state: "published" }), NOW).disabled).toBe(true);
    expect(publishAction(exam({ state: "closed" }), NOW).reason).toBe("This exam has closed.");
    expect(publishAction(exam({ state: "scheduled" }), NOW).reason).toMatch(/publish itself at/);
    expect(publishAction(exam({ readiness: null }), NOW)).toMatchObject({ disabled: true, reason: "Checking readiness…" });
    expect(publishAction(null, NOW).disabled).toBe(true);
  });

  it("summarises readiness", () => {
    const items = readyItems.map((item, index) => ({ ...item, ok: index > 1 }));
    expect(readinessSummary({ ready: false, items })).toMatchObject({ done: 4, total: 6, ready: false });
  });
});

describe("schedule form", () => {
  it("builds the PATCH body from the form and back", () => {
    const form = scheduleFormFrom(exam({ time_limit_minutes: 90, batches: [{ id: 4 }, { id: 9 }] }));
    expect(form).toEqual({ opensAt: "2026-11-14T10:30", closesAt: "2026-11-14T14:30", timeLimit: "90", batchIds: [4, 9] });
    expect(schedulePayload(form)).toEqual({
      opens_at: "2026-11-14T10:30:00+05:30",
      closes_at: "2026-11-14T14:30:00+05:30",
      time_limit_minutes: 90,
      batch_ids: [4, 9],
    });
    expect(schedulePayload({ ...form, timeLimit: "" }).time_limit_minutes).toBeNull();
  });

  it("catches a closing time before the opening time and bad limits", () => {
    expect(scheduleProblem({ opensAt: "2026-11-14T10:30", closesAt: "2026-11-14T09:00", timeLimit: "" })).toMatch(/close after/);
    expect(scheduleProblem({ opensAt: "2026-11-14T10:30", closesAt: "2026-11-14T12:00", timeLimit: "0" })).toMatch(/between 1 and 1440/);
    expect(scheduleProblem({ opensAt: "2026-11-14T10:30", closesAt: "2026-11-14T12:00", timeLimit: "60" })).toBe("");
  });
});

describe("upload helpers", () => {
  it("reads the server's problem list", () => {
    const error = { response: { data: { errors: { detail: "x", problems: ["questions[0].points: must be between 1 and 100000"] } } } };
    expect(uploadProblems(error)).toEqual(["questions[0].points: must be between 1 and 100000"]);
    expect(uploadProblems(new Error("network"))).toEqual([]);
  });

  it("describes a dry run in counts only", () => {
    const lines = previewLines({
      slug: "week-5",
      title: "Week 5",
      exam_created: true,
      question_count: 3,
      total_points: 1000,
      created: 3,
      updated: 0,
      unchanged: 0,
      deactivated: 0,
      removed: 0,
      materials_referenced: 1,
      changed_with_attempts: [],
      time_limit_minutes: 120,
    });
    expect(lines[0]).toBe("New exam “Week 5” (week-5).");
    expect(lines[1]).toMatch(/^3 question\(s\), 1000 points: 3 new/);
    expect(lines).toContain("Time limit: 120 minutes.");
  });

  it("lists evidence still to upload", () => {
    const missing = missingMaterials({
      questions: [{ key: "q1", materials: [{ path: "/a.jpg", uploaded: true }, { path: "/b.pdf", uploaded: false }] }],
    });
    expect(missing).toEqual([{ path: "/b.pdf", uploaded: false, question: "q1" }]);
  });
});

describe("student Console card", () => {
  const labs = "https://labs.example/#exam";
  it("shows an open exam with a labs link", () => {
    const card = studentExamCard(
      { enabled: true, reason: "ok", exam: { slug: "w5", title: { en: "Week 5" }, window: "open", closes_at: "2026-11-14T09:00:00Z" } },
      labs
    );
    expect(card).toMatchObject({ tone: "open", label: "Exam open now", title: "Week 5", href: labs });
  });

  it("shows the next scheduled exam, or nothing", () => {
    const next = { slug: "w6", title: { en: "Week 6" }, window: "not_open", opens_at: "2026-11-20T04:00:00Z" };
    expect(studentExamCard({ enabled: false, reason: "not_assigned", exam: null, next_exam: next }, labs)).toMatchObject({
      tone: "upcoming",
      title: "Week 6",
    });
    expect(studentExamCard({ enabled: false, reason: "no_batch", exam: null, next_exam: null }, labs)).toBeNull();
    expect(studentExamCard(null, labs)).toBeNull();
  });
});
