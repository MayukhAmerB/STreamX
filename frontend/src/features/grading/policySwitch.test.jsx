// Grading › Settings (WS-D2): the self-service switch is a real, labelled
// role="switch" (the Console ships no Carbon Toggle styles) and its helper
// text follows the state.
import { describe, expect, it, vi } from "vitest";

import { act, fire, renderTree } from "../../test-utils/renderTree";
import ReportPolicyPanel from "../reports/ReportPolicyPanel";

vi.mock("../reports/reportsApi", () => ({
  updateCoursePolicy: vi.fn(),
  getCoursePolicy: () =>
    Promise.resolve({
      data: {
        data: {
          self_service: false,
          due_weekday: 6,
          due_time: "23:59",
          grace_hours: 48,
          late_penalty_percent_per_day: 10,
          max_targets_per_week: null,
          marks_visibility: "on_grade",
        },
      },
    }),
}));

// Carbon form controls need a DOM; plain stand-ins keep the test on the switch.
vi.mock("@carbon/react", () => ({
  Button: ({ children, onClick, disabled }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  InlineLoading: ({ description }) => <p>{description}</p>,
  InlineNotification: ({ title, subtitle }) => (
    <p>
      {title} {subtitle}
    </p>
  ),
  Select: ({ labelText, children }) => (
    <label>
      {labelText}
      <select>{children}</select>
    </label>
  ),
  SelectItem: ({ value, text }) => <option value={value}>{text}</option>,
  TextInput: ({ labelText, value }) => (
    <label>
      {labelText}
      <input value={value} readOnly />
    </label>
  ),
}));

describe("report policy switch", () => {
  it("toggles aria-checked and the helper text, without saving on its own", async () => {
    let tree;
    await act(async () => {
      tree = await renderTree(<ReportPolicyPanel courseId={7} />);
    });
    await act(async () => {});
    const toggle = tree.find((node) => node.props?.role === "switch");
    expect(toggle).toBeTruthy();
    expect(toggle.props["aria-checked"]).toBe(false);
    expect(toggle.props["aria-describedby"]).toBe("rpt-policy-self-service-7-help");
    expect(tree.text()).toContain("Self-service weekly reports");
    expect(tree.text()).toContain("Off: you set each week's target.");

    await fire(toggle, "onClick");
    const toggled = tree.find((node) => node.props?.role === "switch");
    expect(toggled.props["aria-checked"]).toBe(true);
    expect(tree.text()).toContain("On: students name their targets, weeks are automatic.");
    await tree.unmount();
  });
});
