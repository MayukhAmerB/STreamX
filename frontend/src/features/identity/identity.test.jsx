import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { StudentIdentityHeader } from "./StudentIdentityHeader";
import { EMPTY, identityFields, identityLine, identityStats, rollNumber } from "./identityModel";
import { ResultsPanel } from "../../pages/ConsoleExamDetailPage";
import { CourseworkExamsView } from "../coursework/CourseworkExamsPage";

const block = (overrides = {}) => ({
  roll_number: "AL-SYD-00042",
  real_name: "Asha Rao",
  handle: "quiet_falcon",
  handle_most_recent: "amber_lynx",
  handle_changed: true,
  snapshot: true,
  user_id: 42,
  stats: {
    xp: 1520,
    rank: "Analyst",
    attendance_percent: 87.5,
    attendance_attended: 7,
    attendance_total: 8,
    reports_submitted: 6,
    reports_graded: 5,
    reports_graded_average: 78.4,
    exam_score: 66.7,
    exams_taken: 1,
  },
  ...overrides,
});

function html(element) {
  return renderToStaticMarkup(<StaticRouter location="/">{element}</StaticRouter>);
}

function order(markup, labels) {
  return labels.map((label) => markup.indexOf(label));
}

describe("identity model", () => {
  it("uses the canonical roll number format", () => {
    expect(rollNumber(42)).toBe("AL-SYD-00042");
    expect(rollNumber(123456)).toBe("AL-SYD-123456");
  });

  it("keeps the owner order: roll number, real name, handle", () => {
    expect(identityFields(block()).map((field) => field.key)).toEqual(["roll_number", "real_name", "handle"]);
    const handle = identityFields(block())[2];
    expect(handle.label).toBe("Handle at submission");
    expect(handle.value).toBe("@quiet_falcon");
    expect(handle.note).toBe("Most recent: @amber_lynx");
  });

  it("shows a dash when there is no handle", () => {
    const fields = identityFields(block({ handle: null, handle_most_recent: null, handle_changed: false, snapshot: false }));
    expect(fields[2]).toMatchObject({ label: "Handle", value: EMPTY, note: "" });
  });

  it("orders stats XP, rank, attendance, reports, exam and hides XP while engagement is off", () => {
    expect(identityStats(block().stats).map((cell) => cell.key)).toEqual(["xp", "rank", "attendance", "reports", "exam"]);
    const off = identityStats({ ...block().stats, xp: null, rank: null });
    expect(off.map((cell) => cell.key)).toEqual(["attendance", "reports", "exam"]);
    expect(off[0].note).toBe("7 of 8 classes (40+ min live)");
  });

  it("builds a dense line in the same order", () => {
    expect(identityLine(block())).toBe("AL-SYD-00042 · Asha Rao · @quiet_falcon");
    expect(identityLine(null, { full_name: "Legacy" })).toBe("Legacy");
  });
});

describe("StudentIdentityHeader", () => {
  it("renders read-only, in order, before anything else", () => {
    const markup = html(<StudentIdentityHeader identity={block()} />);
    const positions = order(markup, ["Roll number", "Real name", "Handle at submission", "XP", "Rank", "Attendance", "Reports", "Exam score"]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((value) => value >= 0)).toBe(true);
    expect(markup).toContain("Auto-filled · read-only");
    expect(markup).toContain("Most recent: @amber_lynx");
    expect(markup).not.toContain("<input");
  });

  it("renders a loading and an error state", () => {
    expect(html(<StudentIdentityHeader loading />)).toContain('aria-busy="true"');
    expect(html(<StudentIdentityHeader error="Network down." onRetry={() => {}} />)).toContain("Try again");
  });

  it("leads the Console exam screen", () => {
    const markup = html(
      <CourseworkExamsView
        eligibility={{ enabled: true, exam: { slug: "cold", window: "open", title: { en: "Operation" } }, next_exam: null }}
        identity={<StudentIdentityHeader identity={block()} eyebrow="Exam candidate" />}
      />
    );
    expect(markup.indexOf("AL-SYD-00042")).toBeGreaterThan(-1);
    expect(markup.indexOf("AL-SYD-00042")).toBeLessThan(markup.indexOf("Start exam"));
  });

  it("puts the student block first in exam results", () => {
    const results = {
      exam: { slug: "cold", title: "Cold", state: "closed", question_count: 1, total_points: 100 },
      stats: { participants: 1, submitted: 1, active: 0, expired: 0, average_score: 50, top_score: 50 },
      participants: [
        {
          identity: block(),
          rank: 1,
          student: { id: 42, full_name: "Asha Rao", email: "asha@example.com" },
          batch: null,
          status: "submitted",
          score: 50,
          solved_count: 1,
          wrong_count: 0,
          attempt_count: 1,
          started_at: "2026-11-14T06:00:00Z",
          deadline_at: null,
          submitted_at: "2026-11-14T07:00:00Z",
        },
      ],
      questions: [],
    };
    const markup = html(<ResultsPanel results={results} csvHref="/x.csv" studentHref={(id) => `/s/${id}`} />);
    expect(markup).toContain("AL-SYD-00042 · Asha Rao · @quiet_falcon");
    expect(markup.indexOf("Student (roll number")).toBeLessThan(markup.indexOf(">#<"));
  });
});
