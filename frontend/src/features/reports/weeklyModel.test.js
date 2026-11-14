import { describe, expect, it } from "vitest";

import { describePolicy, parseMaxTargets } from "./ReportPolicyPanel";
import {
  clientTargetKey,
  fileRows,
  fileStateLabel,
  findExistingTarget,
  readTargetConflict,
  slotsText,
  submitBlockReason,
  targetNameError,
  weekChoices,
  weekStatusText,
} from "./weeklyModel";

describe("clientTargetKey (mirrors apps.core.textnorm.target_key)", () => {
  it.each([
    ["Acme Pvt Ltd", "acme"],
    ["ACME Private Limited", "acme"],
    ["The Acme Corp.", "acme"],
    // A domain keeps its TLD and a handle stays a handle (full table: targetKey.test.js).
    ["https://www.acme.com/about", "acme.com"],
    ["acme.co.in", "acme.co.in"],
    ["ＡＣＭＥ", "acme"],
    ["Café Coffee Day", "cafe coffee day"],
    ["The Company", "the company"],
    ["@acme_hq", "@acme_hq"],
    ["Tata Consultancy Services", "tata consultancy services"],
  ])("%s -> %s", (input, expected) => {
    expect(clientTargetKey(input)).toBe(expected);
  });

  it("finds an existing target with the same key", () => {
    const targets = [{ id: 4, target_name: "Acme Pvt Ltd" }];
    expect(findExistingTarget("acme", targets)?.id).toBe(4);
    expect(findExistingTarget("Globex", targets)).toBeNull();
    expect(findExistingTarget("", targets)).toBeNull();
  });
});

describe("submitBlockReason", () => {
  const clean = { id: 1, name: "r.pdf", scan_status: "clean", scan_pending: false, status: "done" };
  it("explains every blocked state in order", () => {
    expect(submitBlockReason({ enabled: false, disabledReason: "Reports are not enabled for this course." })).toBe(
      "Reports are not enabled for this course."
    );
    expect(submitBlockReason({ canChange: false, lockReason: "The deadline has passed." })).toBe("The deadline has passed.");
    expect(submitBlockReason({ targetName: "" })).toMatch(/Type the name/);
    expect(submitBlockReason({ targetName: "x" })).toMatch(/at least 2/);
    expect(submitBlockReason({ targetName: "Acme", files: [] })).toBe("Add at least one file.");
    expect(submitBlockReason({ targetName: "Acme", files: [{ status: "uploading" }] })).toBe("Wait for the upload to finish.");
    expect(submitBlockReason({ targetName: "Acme", files: [{ ...clean, scan_pending: true, scan_status: "unscanned" }] })).toBe(
      "Checking your files for viruses…"
    );
    expect(submitBlockReason({ targetName: "Acme", files: [{ ...clean, scan_status: "infected", blocked_reason: "Eicar" }] })).toMatch(
      /virus scanner blocked/
    );
    expect(submitBlockReason({ targetName: "Acme", files: [clean] })).toBe("");
  });

  it("validates target names", () => {
    expect(targetNameError("Acme")).toBe("");
    expect(targetNameError("!!")).toMatch(/letters or numbers/);
  });
});

describe("week text", () => {
  const now = Date.parse("2026-11-14T06:30:00Z");
  it("shows the due time, the late window and penalties", () => {
    expect(weekStatusText({ status: "open", due_at: "2026-11-15T18:29:59Z" }, now)).toMatch(/^Due Sun 15 Nov/);
    expect(weekStatusText({ status: "open", due_at: "2026-11-14T18:29:59Z" }, now)).toMatch(/less than a day left/);
    expect(weekStatusText({ status: "late", late_until: "2026-11-17T18:29:59Z", penalty_percent: "10.00" }, now)).toMatch(
      /^Late window: accepted until Tue 17 Nov.*with 10% off\.$/
    );
    expect(weekChoices([{ which: "current" }, { which: "previous", penalty_percent: "20.00" }]).map((item) => item.label)).toEqual([
      "This week",
      "Last week (late, -20%)",
    ]);
    expect(slotsText({ slots_left: null })).toBe("");
    expect(slotsText({ slots_left: 0 })).toMatch(/most targets/);
    expect(slotsText({ slots_left: 2 })).toBe("2 more targets allowed this week.");
  });
});

describe("conflicts and files", () => {
  it("reads 409 duplicate and similar answers", () => {
    const duplicate = readTargetConflict({
      response: { status: 409, data: { code: "duplicate_target", message: "You already have…", errors: { existing: { id: 9, target_name: "Acme" } } } },
    });
    expect(duplicate.code).toBe("duplicate_target");
    expect(duplicate.existing.id).toBe(9);
    const similar = readTargetConflict({
      response: { status: 409, data: { code: "similar_target", errors: { suggestions: [{ id: 3, target_name: "Globex" }] } } },
    });
    expect(similar.suggestions[0].id).toBe(3);
    expect(readTargetConflict({ response: { status: 400, data: {} } })).toBeNull();
  });

  it("merges server files with local uploads and labels states", () => {
    const target = { draft_files: [{ id: 1, name: "a.pdf", scan_pending: true, scan_status: "unscanned" }] };
    const rows = fileRows(target, [{ key: "local-1", name: "b.pdf", status: "uploading", progress: 0.5 }, { key: "local-2", id: 1, name: "a.pdf" }]);
    expect(rows.map((row) => row.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(fileStateLabel(rows[0])).toBe("Scanning…");
    expect(fileStateLabel(rows[1])).toBe("Uploading 50%");
    expect(fileStateLabel({ scan_status: "clean" })).toBe("Ready");
    expect(fileStateLabel({ scan_status: "infected", blocked_reason: "Eicar" })).toBe("Blocked: Eicar");
  });
});

describe("policy panel helpers", () => {
  it("describes and validates the policy", () => {
    expect(describePolicy({ due_weekday: 6, due_time: "23:59:00", grace_hours: 48, late_penalty_percent_per_day: "10.00", max_targets_per_week: null })).toBe(
      "Due Sunday 23:59 IST · 48 h late window at -10%/day · no target limit"
    );
    expect(parseMaxTargets("")).toEqual({ value: null, error: "" });
    expect(parseMaxTargets("3")).toEqual({ value: 3, error: "" });
    expect(parseMaxTargets("0").error).toMatch(/1 to 50/);
  });
});
