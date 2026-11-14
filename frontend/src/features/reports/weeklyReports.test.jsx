import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Carbon notifications check focusability against a real DOM; a plain stand-in
// keeps the same props contract (same approach as reportsUi.test.jsx).
vi.mock("@carbon/react", async (importOriginal) => {
  const actual = await importOriginal();
  const InlineNotification = ({ title, subtitle, children, role }) => (
    <div role={role || "status"}>
      {title} {subtitle}
      {children}
    </div>
  );
  const Button = ({ hasIconOnly, iconDescription, renderIcon: _icon, tooltipPosition: _position, kind: _kind, size: _size, ...rest }) =>
    hasIconOnly ? <button type="button" aria-label={iconDescription} {...rest} /> : <actual.Button kind={_kind} size={_size} renderIcon={_icon} {...rest} />;
  return { ...actual, InlineNotification, Button };
});

import { groupQueue, QueueList, SignalBadges } from "../../pages/ReportsQueuePage";
import { WeeklySection } from "../../pages/ReportsPage";
import { WeeklyReportView } from "./WeeklyReportCard";

const NOW = Date.parse("2026-11-14T06:30:00Z");

beforeAll(() => {
  vi.stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const rules = {
  allowed_extensions: ["pdf", "docx"],
  max_files: 5,
  max_file_size_mb: 50,
  max_total_size_mb: 200,
  max_marks: "10.00",
  late_penalty_percent_per_day: "10.00",
  grace_hours: 48,
  max_targets_per_week: null,
  marks_visibility: "on_grade",
  brief: "",
};

const week = (overrides = {}) => ({
  which: "current",
  week_start: "2026-11-09",
  week_end: "2026-11-15",
  week_number: 3,
  label: "Week 3 · 9–15 Nov",
  due_at: "2026-11-15T18:29:59Z",
  late_until: "2026-11-17T18:29:59Z",
  status: "open",
  penalty_percent: "0.00",
  task_id: 4,
  slots_left: null,
  targets: [],
  ...overrides,
});

const courseState = (overrides = {}) => ({
  course: { id: 29, title: "OSINT Professional Training Program" },
  enabled: true,
  reason: "",
  legacy_task_count: 0,
  weeks: [week()],
  rules,
  ...overrides,
});

const html = (element) => renderToStaticMarkup(<StaticRouter location="/reports">{element}</StaticRouter>);

describe("WeeklyReportView", () => {
  it("shows one submit flow with week, due time and a disabled reason", () => {
    const out = html(<WeeklyReportView state={courseState()} now={NOW} targetName="" />);
    expect(out).toContain("Submit this week&#x27;s report");
    expect(out).toContain("Week 3 · 9–15 Nov");
    expect(out).toContain("Due Sun 15 Nov");
    expect(out).toContain("Target name");
    expect(out).toContain("Type the name of the target you investigated.");
    expect(out).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>/);
  });

  it("enables Submit once the target has a clean file", () => {
    const target = {
      id: 11,
      target_name: "Acme Pvt Ltd",
      status: "not_submitted",
      can_change: true,
      lock_reason: "",
      version_count: 0,
      draft_files: [],
      rules,
    };
    const files = [{ id: 5, key: "server-5", name: "acme.pdf", size: 2048, scan_status: "clean", scan_pending: false, status: "done" }];
    const out = html(<WeeklyReportView state={courseState()} now={NOW} target={target} files={files} />);
    expect(out).toContain("Your report: Acme Pvt Ltd");
    expect(out).toContain("acme.pdf");
    expect(out).toContain("Ready");
    expect(out).not.toMatch(/<button(?=[^>]*type="submit")(?=[^>]*disabled)[^>]*>/);
  });

  it("shows scanning files and keeps Submit disabled", () => {
    const target = { id: 11, target_name: "Acme", status: "not_submitted", can_change: true, version_count: 0, draft_files: [] };
    const files = [{ id: 5, name: "acme.pdf", scan_status: "unscanned", scan_pending: true, status: "done" }];
    const out = html(<WeeklyReportView state={courseState()} now={NOW} target={target} files={files} />);
    expect(out).toContain("Scanning…");
    expect(out).toContain("Checking your files for viruses…");
  });

  it("offers last week during its late window and lists existing reports", () => {
    const state = courseState({
      weeks: [
        week({ which: "current", label: "Week 4 · 16–22 Nov", week_start: "2026-11-16" }),
        week({
          which: "previous",
          status: "late",
          penalty_percent: "10.00",
          targets: [{ id: 3, target_name: "Initech", status: "submitted", submitted_at: "2026-11-15T10:00:00Z", file_count: 1, is_late: false }],
        }),
      ],
    });
    const out = html(<WeeklyReportView state={state} now={NOW} which="previous" targetName="initech" />);
    expect(out).toContain("Last week (late, -10%)");
    expect(out).toContain("Late window: accepted until");
    expect(out).toContain("You already have a report for “Initech”");
    expect(out).toContain("Open existing");
    expect(out).toContain("Initech");
  });

  it("explains a near-duplicate and offers both choices", () => {
    const conflict = { code: "similar_target", message: "This looks like a target you already reported on this week.", suggestions: [{ id: 3, target_name: "Globex Systems" }] };
    const out = html(<WeeklyReportView state={courseState()} now={NOW} targetName="Globex Sytsems" conflict={conflict} />);
    expect(out).toContain("Open “Globex Systems”");
    expect(out).toContain("It&#x27;s a different target");
  });

  it("is disabled with the reason when the course has reports off", () => {
    const out = html(<WeeklySection courses={[courseState({ enabled: false, reason: "Reports are not enabled for this course.", weeks: [], rules: null })]} now={NOW} />);
    expect(out).toContain("Weekly reports are off.");
    expect(out).toContain("Reports are not enabled for this course.");
    expect(out).not.toContain("Target name");
  });

  it("offers Undo right after submitting", () => {
    const out = html(<WeeklyReportView state={courseState()} now={NOW} undo={{ id: 1, message: "You can undo this for 10 seconds." }} />);
    expect(out).toContain("Report submitted.");
    expect(out).toContain("Undo");
  });
});

describe("grader queue grouping", () => {
  const item = (id, overrides = {}) => ({
    id,
    task: { id: 4, title: "Week 3 reports", week_number: 3, due_at: "2026-11-15T18:29:59Z", max_marks: "10.00", status: "published" },
    student: { id: id + 100, full_name: `Student ${id}`, email: `s${id}@x.test` },
    target_name: "Acme",
    target_key: "acme",
    week_start: "2026-11-09",
    week_label: "Week 3 · 9–15 Nov",
    same_target_count: 0,
    sha256_match_count: 0,
    different_target_confirmed: false,
    status: "submitted",
    submitted_at: "2026-11-14T10:00:00Z",
    is_late: false,
    minutes_late: 0,
    version_count: 1,
    final_marks: null,
    max_marks: "10.00",
    revision: 2,
    ...overrides,
  });

  it("groups by week then target in server order", () => {
    const groups = groupQueue([item(1), item(2, { target_name: "ACME Ltd" }), item(3, { target_name: "Initech", target_key: "initech" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Week 3 · 9–15 Nov");
    expect(groups[0].targets.map((target) => [target.name, target.items.length])).toEqual([
      ["Acme", 2],
      ["Initech", 1],
    ]);
  });

  it("renders same-target and identical-file badges", () => {
    const out = html(<SignalBadges item={item(1, { same_target_count: 1, sha256_match_count: 2, different_target_confirmed: true })} />);
    expect(out).toContain("Same target ×2");
    expect(out).toContain("Identical file ×2");
    expect(out).toContain("Student confirmed distinct target");
    const list = html(<QueueList items={[item(1), item(2)]} grouped onOpen={() => {}} />);
    expect(list).toContain("Week 3 · 9–15 Nov");
    expect(list).toContain("Acme <span");
  });
});
