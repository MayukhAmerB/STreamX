// UI overhaul component behaviour (plan §2.5, §7.5 WS-A unit list).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { act, fire, renderTree, textOf } from "../../../test-utils/renderTree";
import DisabledReason from "./DisabledReason";
import DropZone from "./DropZone";
import EmptyState from "./EmptyState";
import PageHeader from "./PageHeader";
import ResponsiveTable from "./ResponsiveTable";
import ScrollTabs from "./ScrollTabs";
import SidePanel from "./SidePanel";
import StatusTag, { STATUS_VOCABULARY } from "./StatusTag";
import { Toast } from "./toast";

const here = path.dirname(fileURLToPath(import.meta.url));
const scss = fs.readFileSync(path.join(here, "overhaul.scss"), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** matchMedia that answers `narrow` for every max-width query. */
function viewport({ narrow }) {
  vi.stubGlobal("window", {
    matchMedia: (query) => ({ matches: /max-width/.test(query) ? narrow : !narrow, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
}

const columns = [
  { key: "name", header: "Student" },
  { key: "course", header: "Course" },
  { key: "status", header: "Status", render: (row) => <StatusTag status={row.status} /> },
];
const rows = [
  { id: 1, name: "Sana Shaikh", course: "OSINT Foundations", status: "open" },
  { id: 2, name: "Imran Ali", course: "OSINT Foundations", status: "late" },
];

describe("ResponsiveTable", () => {
  it("renders a table with a sticky header and row headers on wide screens", async () => {
    viewport({ narrow: false });
    const tree = await renderTree(
      <MemoryRouter>
        <ResponsiveTable columns={columns} rows={rows} caption="Requests" getRowHref={(row) => `/console/admin/requests?open=${row.id}`} />
      </MemoryRouter>
    );
    expect(tree.find((node) => node.type === "table")).not.toBeNull();
    const rowHeaders = tree.all((node) => node.type === "th" && node.props.scope === "row");
    expect(rowHeaders.map(textOf)).toEqual(["Sana Shaikh", "Imran Ali"]);
    expect(tree.find((node) => node.type === "a" && node.props.href === "/console/admin/requests?open=1")).not.toBeNull();
    await tree.unmount();
  });

  it("renders cards under 672 px, so a phone never scrolls sideways", async () => {
    viewport({ narrow: true });
    const tree = await renderTree(
      <MemoryRouter>
        <ResponsiveTable columns={columns} rows={rows} />
      </MemoryRouter>
    );
    expect(tree.find((node) => node.type === "table")).toBeNull();
    const cards = tree.all((node) => String(node.props.className).includes("sc-table-cards__card"));
    expect(cards).toHaveLength(2);
    expect(textOf(cards[0])).toContain("CourseOSINT Foundations");
    await tree.unmount();
  });

  it("selects rows (and all rows) and reports the selection", async () => {
    viewport({ narrow: false });
    const onSelectionChange = vi.fn();
    const tree = await renderTree(
      <MemoryRouter>
        <ResponsiveTable columns={columns} rows={rows} selectable onSelectionChange={onSelectionChange} />
      </MemoryRouter>
    );
    await fire(tree.getByLabel("input", "Select all rows"), "onChange");
    expect(onSelectionChange).toHaveBeenLastCalledWith([1, 2]);
    const [firstRow] = tree.all((node) => node.type === "input" && node.props["aria-label"] === "Select row");
    await fire(firstRow, "onChange");
    expect(onSelectionChange).toHaveBeenLastCalledWith([2]);
    await tree.unmount();
  });

  it("shows the caller's empty state when there are no rows", async () => {
    viewport({ narrow: false });
    const tree = await renderTree(
      <MemoryRouter>
        <ResponsiveTable columns={columns} rows={[]} emptyState={<EmptyState title="No requests waiting" />} />
      </MemoryRouter>
    );
    expect(tree.text()).toContain("No requests waiting");
    await tree.unmount();
  });
});

describe("DisabledReason", () => {
  it("stays focusable, explains itself and can never navigate", async () => {
    const tree = await renderTree(
      <DisabledReason as="button" reason="Teaching tools are switched off for now." href="/console/teach">
        Teach
      </DisabledReason>
    );
    const host = tree.find((node) => node.props?.["aria-disabled"] === "true");
    expect(host.type).toBe("button");
    expect(host.props.tabIndex).toBe(0);
    expect(host.props.href).toBeUndefined();
    const tip = tree.find((node) => node.props.role === "tooltip");
    expect(host.props["aria-describedby"]).toBe(tip.props.id);
    expect(textOf(tip)).toBe("Teaching tools are switched off for now.");
    await fire(host, "onClick");
    expect(tree.find((node) => node.props?.["aria-disabled"] === "true").props["data-tip"]).toBe("open");
    await tree.unmount();
  });
});

describe("DropZone", () => {
  it("refuses files over the limit with a sentence that names them", async () => {
    const onFiles = vi.fn();
    const tree = await renderTree(<DropZone accept=".json" maxBytes={1024} onFiles={onFiles} />);
    const zone = tree.find((node) => String(node.props.className).startsWith("sc-drop-zone"));
    await fire(zone, "onDrop", { dataTransfer: { files: [{ name: "exam.json", size: 10 }, { name: "huge.json", size: 4096 }] } });
    expect(onFiles).toHaveBeenCalledWith([{ name: "exam.json", size: 10 }]);
    expect(tree.text()).toContain("huge.json is larger than 1.0 KB.");
    await tree.unmount();
  });

  it("explains why it is disabled", async () => {
    const tree = await renderTree(<DropZone disabledReason="Choose a course first" onFiles={() => {}} />);
    expect(tree.find((node) => node.type === "input").props.disabled).toBe(true);
    expect(tree.text()).toContain("Choose a course first");
    await tree.unmount();
  });
});

describe("Toast (M10)", () => {
  it("dismisses after the timeout, and pauses while hovered or focused (WCAG 2.2.1)", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toast = { id: 7, kind: "success", title: "Approved", timeout: 5000, action: { label: "Undo", onClick() {} } };
    const tree = await renderTree(<Toast toast={toast} onDismiss={onDismiss} />);
    const root = tree.find((node) => String(node.props.className).startsWith("sc-toast"));
    await act(() => vi.advanceTimersByTime(2000));
    await fire(root, "onMouseEnter");
    await act(() => vi.advanceTimersByTime(10000));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(tree.find((node) => String(node.props.className).startsWith("sc-toast")).props.className).toContain("is-paused");
    await fire(tree.find((node) => String(node.props.className).startsWith("sc-toast")), "onMouseLeave", { currentTarget: { contains: () => false } });
    await act(() => vi.advanceTimersByTime(2900));
    expect(onDismiss).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(200));
    expect(onDismiss).toHaveBeenCalledWith(7);
    expect(tree.text()).toContain("Undo");
    await tree.unmount();
  });

  it("shows the time left as a transform hairline that pauses", () => {
    expect(scss).toMatch(/\.sc-toast__timer \{[^}]*animation-name: sc-toast-timer;/);
    expect(scss).toMatch(/\.is-paused & \{\s+animation-play-state: paused;/);
    expect(scss).toMatch(/@keyframes sc-toast-timer \{\s+from \{\s+transform: scaleX\(1\);/);
  });
});

describe("ScrollTabs", () => {
  it("marks the active tab, shows badges and draws one indicator", async () => {
    const tree = await renderTree(
      <MemoryRouter>
        <ScrollTabs
          activeKey="grades"
          tabs={[
            { key: "week", label: "This week", href: "/reports", badge: 1 },
            { key: "grades", label: "Grades", href: "/gradebook" },
            { key: "exams", label: "Exams", href: "/coursework/exams" },
          ]}
        />
      </MemoryRouter>
    );
    const current = tree.all((node) => node.props["aria-current"] === "page");
    expect(current.map(textOf)).toEqual(["Grades"]);
    expect(tree.text()).toContain("This week1");
    const nav = tree.find((node) => node.type === "nav");
    expect(nav.props["data-scroll-end"]).toBeDefined();
    await tree.unmount();
    expect(scss).toMatch(/\.sc-scroll-tabs__bar \{[^}]*transition: transform var\(--sc-duration-moderate-02\)/);
  });
});

describe("SidePanel", () => {
  it("names itself, closes on Esc and keeps the exit animation before unmounting", async () => {
    vi.useFakeTimers();
    const keyListeners = new Set();
    vi.stubGlobal("window", {
      addEventListener: (name, fn) => name === "keydown" && keyListeners.add(fn),
      removeEventListener: (name, fn) => keyListeners.delete(fn),
      matchMedia: () => ({ matches: false }),
    });
    const onClose = vi.fn();
    const tabs = [
      { key: "summary", label: "Summary", content: <p>Recording summary</p> },
      { key: "activity", label: "Activity", content: <p>Uploaded by Sana</p> },
    ];
    const tree = await renderTree(<SidePanel open title="Week 3 recording" onClose={onClose} tabs={tabs} />);
    expect(tree.text()).toContain("Recording summary");
    await fire(tree.getByLabel("button", "Activity"), "onClick");
    expect(tree.text()).toContain("Uploaded by Sana");
    await act(() => [...keyListeners].forEach((fn) => fn({ key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
    await tree.rerender(<SidePanel open={false} title="Week 3 recording" onClose={onClose} tabs={tabs} />);
    expect(tree.find((node) => node.type === "aside").props.className).toContain("is-leaving");
    await act(() => vi.advanceTimersByTime(200));
    expect(tree.find((node) => node.type === "aside")).toBeNull();
    await tree.unmount();
  });
});

describe("PageHeader v2 and StatusTag", () => {
  it("has no Console eyebrow, renders breadcrumbs and the one accent action", async () => {
    const tree = await renderTree(
      <MemoryRouter>
        <PageHeader
          title="Requests"
          description="Approve or reject enrolment requests."
          breadcrumbs={[{ label: "Admin", href: "/console/admin" }, { label: "Requests" }]}
          primaryAction={{ label: "Review 4", href: "/console/admin/requests", accent: true }}
          overflowActions={[{ label: "Open back office", href: "/admin/courses/enrollment/" }]}
        />
      </MemoryRouter>
    );
    expect(tree.find((node) => String(node.props.className).includes("cds-page-header__eyebrow"))).toBeNull();
    expect(tree.find((node) => node.props["aria-current"] === "page" && textOf(node) === "Requests")).not.toBeNull();
    expect(tree.all((node) => String(node.props.className).includes("sc-button--accent"))).not.toHaveLength(0);
    expect(tree.getByLabel("button", "More actions").props["aria-expanded"]).toBe(false);
    await tree.unmount();
  });

  it("always pairs a status word with an icon or the live dot", async () => {
    for (const status of Object.keys(STATUS_VOCABULARY)) {
      const tree = await renderTree(<StatusTag status={status} />);
      const icon = tree.find((node) => node.type === "svg" || String(node.props.className).includes("sc-live-dot"));
      expect(icon, status).not.toBeNull();
      expect(tree.text()).toBe(STATUS_VOCABULARY[status].label);
      await tree.unmount();
    }
  });
});

describe("overhaul.scss motion rules", () => {
  it("animates only transform and opacity and has a reduced-motion state", () => {
    const transitions = scss.match(/transition:[^;]+;/g) || [];
    for (const rule of transitions) expect(rule, rule).not.toMatch(/\b(width|height|inline-size|block-size|margin|padding|top|left|right|bottom|box-shadow|all)\b/);
    expect(scss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s+@include reduced-motion-rules;/);
    expect(scss).toMatch(/:root\[data-motion='reduce'\] \{\s+@include reduced-motion-rules;/);
    expect(scss).not.toMatch(/glow/);
  });
});
