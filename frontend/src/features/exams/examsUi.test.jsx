import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BatchGradebookTable, StudentSections } from "../../pages/GradebookPage";
import { ExamListTable, ExamUploadPanel, uploadReasons } from "../../pages/ConsoleExamsPage";
import { MaterialsPanel, PublishBar, ReadinessChecklist, ResultsPanel } from "../../pages/ConsoleExamDetailPage";
import { ExamConsoleCardView, staffExamCard } from "./ExamConsoleCard";

const NOW = Date.parse("2026-11-14T06:00:00Z");

function html(element) {
  return renderToStaticMarkup(<StaticRouter location="/console/exams">{element}</StaticRouter>);
}

const readiness = (overrides = {}) => ({
  ready: false,
  items: [
    { id: "pepper", label: "Answer pepper configured", ok: false, detail: "CTF_ANSWER_PEPPER is not set on the server, so answers cannot be checked." },
    { id: "questions", label: "Questions loaded", ok: true, detail: "3 question(s)." },
  ],
  reasons: ["CTF_ANSWER_PEPPER is not set on the server, so answers cannot be checked."],
  ...overrides,
});

const exam = (overrides = {}) => ({
  slug: "week-5",
  title: "Week 5 CTF",
  state: "draft",
  window: "open",
  can_manage: true,
  opens_at: "2026-11-14T05:00:00Z",
  closes_at: "2026-11-14T09:00:00Z",
  question_count: 3,
  total_points: 1000,
  batches: [{ id: 1, title: "Batch 7" }],
  ready: false,
  stats: { participants: 4 },
  readiness: readiness(),
  questions: [
    { key: "q1", order: 1, materials: [{ path: "/materials/exams/week-5-x/photo.jpg", label: "Photo", uploaded: false }] },
  ],
  ...overrides,
});

describe("Console exams", () => {
  it("keeps Publish disabled with the reason while the checklist fails", () => {
    const markup = html(<PublishBar exam={exam()} now={NOW} />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Publish now<\/button>/);
    expect(markup).toContain("CTF_ANSWER_PEPPER is not set on the server");
  });

  it("enables Publish once ready and offers Close for a published exam", () => {
    const ready = exam({ readiness: readiness({ ready: true, items: [{ id: "pepper", label: "x", ok: true, detail: "" }], reasons: [] }) });
    expect(html(<PublishBar exam={ready} now={NOW} />)).not.toMatch(/disabled=""[^>]*>Publish now/);
    expect(html(<PublishBar exam={exam({ state: "published" })} now={NOW} />)).toContain("Close exam now");
    expect(html(<PublishBar exam={exam({ can_manage: false })} now={NOW} />)).toBe("");
  });

  it("shows each readiness item with its detail", () => {
    const markup = html(<ReadinessChecklist readiness={readiness()} />);
    expect(markup).toContain("Readiness: 1 of 2");
    expect(markup).toContain("Answer pepper configured");
    expect(markup).toContain("3 question(s).");
  });

  it("enables Load only after a passing dry run, and lists problems otherwise", () => {
    const idle = html(<ExamUploadPanel fileName="exam.json" />);
    expect(idle).toMatch(/disabled=""[^>]*>Load exam/);
    expect(idle).toContain("Check the file before loading it.");
    const bad = html(<ExamUploadPanel fileName="exam.json" problems={["questions[0].category: must be one of: geoint"]} />);
    expect(bad).toContain("questions[0].category: must be one of: geoint");
    const preview = {
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
    };
    const good = html(<ExamUploadPanel fileName="exam.json" preview={preview} />);
    expect(good).toContain("Dry run passed. Nothing has been saved yet.");
    expect(good).not.toMatch(/disabled=""[^>]*>Load exam/);
  });

  it("explains every disabled import button", () => {
    expect(uploadReasons({ fileName: "" })).toMatchObject({ check: "Choose a file first.", load: "Choose a file first." });
    expect(uploadReasons({ fileName: "exam.json" })).toMatchObject({ check: "", load: "Check the file before loading it." });
    expect(uploadReasons({ fileName: "exam.json", preview: { slug: "x" } })).toMatchObject({ check: "", load: "", checked: true });
    expect(uploadReasons({ fileName: "exam.json", preview: { slug: "x" }, problems: ["bad"] }).load).toBe("Check the file before loading it.");
    const empty = html(<ExamUploadPanel fileName="" />);
    expect(empty).toContain("Choose a file first.");
    expect(empty).toMatch(/disabled=""[^>]*>[^<]*(<[^>]*>[^<]*)*Check file/);
    // The drop zone's input is the "Exam file" field (the E2E journey picks it by that label).
    expect(empty).toMatch(/<label[^>]*>(<span[^>]*>)?Exam file</);
  });

  it("links exams inside the workspace tree", () => {
    expect(html(<ExamListTable exams={[exam()]} basePath="/console/admin/exams" />)).toContain('href="/console/admin/exams/week-5"');
  });

  it("lists exams with their state and links to the detail page", () => {
    const markup = html(<ExamListTable exams={[exam()]} />);
    expect(markup).toContain('href="/console/exams/week-5"');
    expect(markup).toContain("Draft");
    expect(markup).toContain("Batch 7");
  });

  it("offers an upload per missing evidence file for staff only", () => {
    expect(html(<MaterialsPanel exam={exam()} />)).toContain('aria-label="Upload photo.jpg"');
    expect(html(<MaterialsPanel exam={exam({ can_manage: false })} />)).not.toContain("Upload photo.jpg");
  });

  it("renders results with solve rates and wrong-answer clusters", () => {
    const results = {
      exam: { total_points: 100 },
      stats: { participants: 1, active: 0, average_score: 50, top_score: 50 },
      participants: [
        { rank: 1, student: { id: 3, full_name: "Asha", email: "a@x" }, batch: { title: "Batch 7" }, status: "expired", score: 50, solved_count: 1, wrong_count: 2 },
      ],
      questions: [{ key: "q1", order: 1, title: "Harbour", solve_rate: 50, solved: 1, attempted: 2, wrong_answers: [{ answer: "port x", count: 2 }] }],
    };
    const markup = html(<ResultsPanel results={results} csvHref="/api/x.csv" />);
    expect(markup).toContain("Time over");
    expect(markup).toContain("port x ×2");
    expect(markup).toContain('href="/gradebook/students/3"');
  });

  it("builds the staff card from open and scheduled exams", () => {
    expect(staffExamCard({ open: [{ slug: "w5", title: "Week 5", active: 12 }], scheduled: [] })).toMatchObject({
      label: "Exam open now",
      to: "/console/exams/w5",
      meta: "12 student(s) answering right now",
    });
    expect(staffExamCard({ open: [], scheduled: [] })).toBeNull();
    const markup = html(<ExamConsoleCardView card={{ tone: "open", label: "Exam open now", title: "Week 5", meta: "Closes soon", href: "https://labs.example/#exam" }} />);
    expect(markup).toContain('href="https://labs.example/#exam"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

describe("Unified gradebook", () => {
  const book = {
    course: { id: 1, title: "Batch G" },
    columns: [
      { key: "report:1", kind: "report", id: 1, title: "Target: Acme", short_title: "W1", max: 10 },
      { key: "exam:2", kind: "exam", id: 2, title: "Midterm CTF", short_title: "Midterm CTF", max: 40 },
    ],
    rows: [
      {
        student: { id: 5, full_name: "Gina", email: "g@x" },
        cells: [
          { key: "report:1", kind: "report", status: "graded", value: 8, max: 10, is_late: false, rank: null },
          { key: "exam:2", kind: "exam", status: "result", value: 40, max: 40, is_late: false, rank: 1 },
        ],
        totals: { reports: { percentage: 80 }, exams: { percentage: 100 }, overall_percentage: 90, missing_count: 0, late_count: 0 },
      },
    ],
  };

  it("shows reports and exams side by side with per-part percentages", () => {
    const markup = html(<BatchGradebookTable book={book} />);
    expect(markup).toContain("8/10");
    expect(markup).toContain("40/40 (#1)");
    expect(markup).toContain("90%");
    expect(markup).toContain('href="/gradebook/students/5"');
  });

  it("shows a student's sections, or an empty state", () => {
    const data = {
      courses: [{ course: { id: 1, title: "Batch G" }, columns: book.columns, cells: book.rows[0].cells, totals: book.rows[0].totals }],
    };
    expect(html(<StudentSections data={data} />)).toContain("Midterm CTF");
    expect(html(<StudentSections data={{ courses: [] }} />)).toContain("Marks appear here");
  });
});

vi.mock("../../hooks/useAuth", () => ({ useAuth: () => null }));
