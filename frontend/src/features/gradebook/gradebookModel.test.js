import { describe, expect, it } from "vitest";

import { batchSummary, cellText, cellTone, columnLabel, formatNumber, formatPercent, sectionSummary } from "./gradebookModel";

describe("gradebook model", () => {
  it("formats marks without trailing zeros", () => {
    expect(formatNumber(8)).toBe("8");
    expect(formatNumber(7.5)).toBe("7.5");
    expect(formatNumber(7.25)).toBe("7.25");
    expect(formatNumber(null)).toBe("–");
    expect(formatPercent(null)).toBe("–");
    expect(formatPercent(66.7)).toBe("66.7%");
  });

  it("shows a value, an exam rank, or the status", () => {
    expect(cellText({ kind: "report", value: 8, max: 10 })).toBe("8/10");
    expect(cellText({ kind: "exam", value: 30, max: 40, rank: 2 })).toBe("30/40 (#2)");
    expect(cellText({ kind: "exam", value: null, status: "absent" })).toBe("Absent");
    expect(cellText({ kind: "report", value: null, status: "under_review" })).toBe("Under review");
    expect(cellText({ kind: "report", value: null, status: "some_new_state" })).toBe("some new state");
    expect(cellTone({ status: "missing", value: null })).toBe("missing");
    expect(cellTone({ status: "pending", value: null })).toBe("pending");
    expect(cellTone({ status: "graded", value: 3 })).toBe("");
  });

  it("labels columns by kind", () => {
    expect(columnLabel({ kind: "exam", title: "Midterm", short_title: "Midterm", max: 40 })).toEqual({
      kind: "Exam",
      title: "Midterm",
      full: "Exam: Midterm /40",
    });
    expect(columnLabel({ kind: "report", title: "Target: Acme", short_title: "W1", max: 10 }).kind).toBe("Report");
  });

  it("summarises a batch and a student section", () => {
    const rows = [
      { totals: { overall_percentage: 90, missing_count: 1, late_count: 0 } },
      { totals: { overall_percentage: null, missing_count: 2, late_count: 1 } },
      { totals: { overall_percentage: 70, missing_count: 0, late_count: 1 } },
    ];
    expect(batchSummary(rows).map((chip) => chip.value)).toEqual([3, "80%", 3, 2]);
    expect(sectionSummary({ reports: { percentage: 80 }, exams: { percentage: null }, overall_percentage: 80 }).map((chip) => chip.value)).toEqual([
      "80%",
      "–",
      "80%",
    ]);
  });
});
