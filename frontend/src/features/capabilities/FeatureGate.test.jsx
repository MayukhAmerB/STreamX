import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";

import capabilities from "../../__contracts__/ui-overhaul/capabilities.json";
import { AuthContext } from "../../context/AuthContext";
import { renderTree } from "../../test-utils/renderTree";
import FeatureGate, { resolveFeatureGate } from "./FeatureGate";

vi.mock("./api", () => ({
  CAPABILITIES_STALE_EVENT: "capabilities:stale",
  fetchCapabilities: vi.fn(() => new Promise(() => {})),
}));

const REASON = "Teaching tools are switched off for now. An admin can turn them on.";
const instructor = { id: 2, role: "instructor", is_admin: false };

function auth({ caps, isAdmin = false, user = instructor } = {}) {
  return { user, isAdmin, isInstructor: user?.role === "instructor", capabilities: caps, refreshCapabilities: () => Promise.resolve(caps) };
}

function Probe() {
  return ` @${useLocation().pathname}`;
}

function tree(value) {
  return (
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={["/console/teach"]}>
        <Routes>
          <Route path="/console/teach" element={<FeatureGate feature="teaching">{"TEACH PAGE"}</FeatureGate>} />
          <Route path="/" element={"WEBSITE HOME"} />
        </Routes>
        <Probe />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeAll(async () => {
  await import("../app-shell/ui");
}, 60000);

describe("resolveFeatureGate", () => {
  it.each([
    ["instructor_off", "disabled", REASON],
    ["instructor_on", "enabled", ""],
    ["student", "hidden", ""],
  ])("%s -> %s", (variant, state, reason) => {
    expect(resolveFeatureGate("teaching", capabilities[variant], false)).toEqual({ state, reason });
  });

  it("is 'checking' while capabilities load and never enabled before they arrive", () => {
    expect(resolveFeatureGate("teaching", null, true).state).toBe("checking");
    expect(resolveFeatureGate("teaching", null, false).state).toBe("disabled");
  });
});

describe("FeatureGate", { timeout: 30000 }, () => {
  it("shows the off page with the reason, in place (no navigation to the website)", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.instructor_off })));
    const text = view.text();
    expect(text).toContain("Teaching is switched off");
    expect(text).toContain(REASON);
    expect(text).toContain("Back to Home");
    expect(text).not.toContain("TEACH PAGE");
    expect(text).not.toContain("WEBSITE HOME");
    expect(text.endsWith("@/console/teach")).toBe(true);
    const link = view.find((node) => node.type === "a" && String(node.props.href || "").length >= 0 && node.props.className === "sc-state__action");
    expect(link.props.href).toBe("/console");
    await view.unmount();
  });

  it("renders the page when teaching is on", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.instructor_on })));
    expect(view.text()).toContain("TEACH PAGE");
    await view.unmount();
  });

  it("shows not-found to a student (they can never act there)", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.student, user: { id: 1, role: "student" } })));
    expect(view.text()).toContain("This page does not exist");
    expect(view.text()).not.toContain("TEACH PAGE");
    await view.unmount();
  });

  it("lets staff through whatever the switch says", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.staff_off, isAdmin: true, user: { id: 3, is_admin: true } })));
    expect(view.text()).toContain("TEACH PAGE");
    await view.unmount();
  });

  it("says 'Checking…' while capabilities load", async () => {
    const view = await renderTree(tree({ user: instructor, isAdmin: false }));
    expect(view.text()).toContain("Checking…");
    expect(view.text()).not.toContain("TEACH PAGE");
    await view.unmount();
  });

  it("swaps an open page to the off state when an admin switches it off, keeping unsaved work", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.instructor_on })));
    expect(view.text()).toContain("TEACH PAGE");
    await view.rerender(tree(auth({ caps: capabilities.instructor_off })));
    const text = view.text();
    expect(text).toContain("Teaching was switched off by an admin. Unsaved changes are kept on this device.");
    expect(text).toContain("Teaching is switched off");
    expect(view.find((node) => String(node.props.className || "").includes("sc-feature-off--live"))).toBeTruthy();
    await view.unmount();
  });

  it("enters once when switched on while open (M20)", async () => {
    const view = await renderTree(tree(auth({ caps: capabilities.instructor_off })));
    expect(view.text()).not.toContain("Teaching was switched off by an admin");
    await view.rerender(tree(auth({ caps: capabilities.instructor_on })));
    expect(view.text()).toContain("TEACH PAGE");
    expect(view.find((node) => node.props.className === "sc-feature-reveal")).toBeTruthy();
    await view.unmount();
  });
});
