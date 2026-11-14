// One crashing widget must never blank the app (E2E run-02: a Carbon
// notification threw after Submit on /reports and React unmounted everything).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import FeatureBoundary from "./FeatureBoundary";

const crash = new Error("Error: component should have no interactive child nodes.");

/** Render the boundary as React does after getDerivedStateFromError. */
function crashed(props = {}) {
  const boundary = new FeatureBoundary({ children: <p>panel</p>, ...props });
  boundary.state = FeatureBoundary.getDerivedStateFromError(crash);
  return boundary;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeatureBoundary", () => {
  it("renders its children while nothing has failed", () => {
    expect(renderToStaticMarkup(<FeatureBoundary label="The weekly report"><p>panel</p></FeatureBoundary>)).toBe("<p>panel</p>");
  });

  it("replaces only the crashed panel with a message and a Try again button beside it", () => {
    const html = renderToStaticMarkup(crashed({ label: "The weekly report for OSINT Batch 4" }).render());
    expect(html).not.toContain("<p>panel</p>");
    expect(html).toContain('data-feature-boundary="The weekly report for OSINT Batch 4"');
    expect(html).toContain("The weekly report for OSINT Batch 4 couldn&#x27;t be shown.");
    expect(html).toContain("the rest of the page still works");
    expect(html).toMatch(/role="alert"/);
    // The recovery button sits beside the Carbon notification, never inside it.
    expect(html).toMatch(/cds-page-notification-group[\s\S]*<\/div><button[^>]*>[\s\S]*Try again/);
  });

  it("Try again clears the error so the panel renders again", () => {
    const boundary = crashed();
    const setState = vi.spyOn(boundary, "setState").mockImplementation((next) => Object.assign(boundary.state, next));
    boundary.reset();
    expect(setState).toHaveBeenCalledWith({ error: null });
    expect(renderToStaticMarkup(boundary.render())).toBe("<p>panel</p>");
  });

  it("resets when a reset key changes (e.g. navigating to another page), not on unrelated updates", () => {
    const boundary = crashed({ resetKeys: ["/reports"] });
    const reset = vi.spyOn(boundary, "setState").mockImplementation(() => {});
    boundary.componentDidUpdate({ resetKeys: ["/reports"] });
    expect(reset).not.toHaveBeenCalled();
    boundary.props = { ...boundary.props, resetKeys: ["/gradebook"] };
    boundary.componentDidUpdate({ resetKeys: ["/reports"] });
    expect(reset).toHaveBeenCalledWith({ error: null });
  });

  it("logs the crash and reports it to onError", () => {
    const onError = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = crashed({ label: "Report settings", onError });
    boundary.componentDidCatch(crash, { componentStack: "\n    at ReportPolicyPanel" });
    expect(onError).toHaveBeenCalledWith(crash, { componentStack: "\n    at ReportPolicyPanel" });
    expect(log.mock.calls[0][0]).toContain('"Report settings" crashed');
  });

  it("supports a custom fallback (node or render function)", () => {
    expect(renderToStaticMarkup(crashed({ fallback: <span>quiet</span> }).render())).toBe("<span>quiet</span>");
    expect(crashed({ fallback: null }).render()).toBeNull();
    const html = renderToStaticMarkup(crashed({ fallback: ({ error }) => <em>{error.message.length > 0 ? "custom" : ""}</em> }).render());
    expect(html).toBe("<em>custom</em>");
  });
});
