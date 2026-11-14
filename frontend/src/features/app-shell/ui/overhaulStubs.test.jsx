// The final props of the UI overhaul components (plan Appendix A.5), first
// written against the WS-0 stubs; WS-A's behaviour tests are in
// components.test.jsx and site-kit/motion/motion.test.jsx.
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CountUp, Meter, RollingDigits } from "../../../site-kit/motion";
import { BarList, StatTile } from "../../../site-kit/data";
import { renderTree } from "../../../test-utils/renderTree";
import { COMMAND_PALETTE_OPEN_EVENT, CommandPalette, openCommandPalette } from "../../command-palette";
import { DisabledReason, NotFoundState, RoutePlaceholder, SegmentedSwitch, StatusTag, STATUS_VOCABULARY } from ".";

describe("UI overhaul component stubs", () => {
  it("StatusTag speaks the one sentence-case vocabulary", async () => {
    expect(Object.keys(STATUS_VOCABULARY)).toEqual(["live", "open", "due", "late", "graded", "draft", "scheduled", "processing", "failed", "published", "on", "off"]);
    const tree = await renderTree(<StatusTag status="processing" />);
    expect(tree.text()).toBe("Processing");
    await tree.unmount();
  });

  it("DisabledReason is focusable, aria-disabled, explained and never a link", async () => {
    const tree = await renderTree(<DisabledReason reason="Choose a file first">Check file</DisabledReason>);
    const [host] = tree.all((node) => node.props?.["aria-disabled"] === "true");
    expect(host.props.tabIndex).toBe(0);
    expect(host.props.href).toBeUndefined();
    expect(tree.text()).toContain("Choose a file first");
    await tree.unmount();
  });

  it("SegmentedSwitch hides hidden options and explains disabled ones", async () => {
    const options = [
      { key: "learn", label: "Learn", state: "enabled" },
      { key: "teach", label: "Teach", state: "disabled", reason: "Teaching tools are switched off for now." },
      { key: "admin", label: "Admin", state: "hidden" },
    ];
    const tree = await renderTree(<SegmentedSwitch options={options} value="learn" />);
    expect(tree.text()).toContain("Learn");
    expect(tree.text()).toContain("Teaching tools are switched off for now.");
    expect(tree.text()).not.toContain("Admin");
    await tree.unmount();
  });

  it("placeholders and not-found pages always offer a way on", async () => {
    const tree = await renderTree(
      <MemoryRouter>
        <RoutePlaceholder title="Requests" links={[{ label: "Course enrolments", href: "/admin/courses/enrollment/" }]} />
        <NotFoundState />
      </MemoryRouter>
    );
    expect(tree.text()).toContain("Requests");
    expect(tree.text()).toContain("Course enrolments");
    expect(tree.text()).toContain("Back to Home");
    // Django links are full page loads.
    expect(tree.all((node) => node.type === "a" && node.props.href === "/admin/courses/enrollment/")).toHaveLength(1);
    await tree.unmount();
  });

  it("motion and data components settle on their final values", async () => {
    const tree = await renderTree(
      <>
        <CountUp value={1200} />
        <RollingDigits value="04:28" />
        <Meter value={0.4} label="Progress" />
        <StatTile label="Average" value="82%" />
        <BarList caption="Marks by week" data={[{ label: "Week 1", value: 7 }]} />
      </>
    );
    expect(tree.text()).toContain((1200).toLocaleString());
    expect(tree.text()).toContain("04:28");
    expect(tree.text()).toContain("Average82%");
    expect(tree.text()).toContain("Week 17");
    const [meter] = tree.all((node) => node.props?.role === "progressbar");
    expect(meter.props["aria-valuenow"]).toBe(40);
    await tree.unmount();
  });

  it("command palette stub exports the open event", () => {
    expect(COMMAND_PALETTE_OPEN_EVENT).toBe("command-palette:open");
    expect(typeof CommandPalette).toBe("function");
    expect(() => openCommandPalette({ initialQuery: "pay" })).not.toThrow();
  });
});
