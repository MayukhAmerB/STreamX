// Regression: Carbon notifications throw "component should have no
// interactive child nodes" when a button is rendered inside them, which blanked
// the whole app after Submit (Undo) and on a duplicate target name (E2E run-02).
// This file deliberately uses the REAL Carbon InlineNotification (no mock).
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const state = {
  enabled: true,
  course: { id: 7, title: "OSINT Batch 4" },
  rules: { allowed_extensions: ["pdf"], max_files: 5, max_file_size_mb: 50 },
  weeks: [
    {
      which: "current",
      label: "Week of 9–15 Nov",
      status: "open",
      due_at: "2026-11-15T18:29:59Z",
      targets: [{ id: 3, target_name: "Acme Pvt Ltd", status: "submitted", submitted_at: "2026-11-14T05:00:00Z", file_count: 1 }],
    },
  ],
};

/** Inner HTML of every element whose class list contains `cds--inline-notification`. */
function notificationBodies(html) {
  const bodies = [];
  const opener = /<div[^>]*class="[^"]*\bcds--inline-notification\b[^"]*"[^>]*>/g;
  let match;
  while ((match = opener.exec(html))) {
    let depth = 1;
    const tag = /<(\/?)div\b[^>]*>/g;
    tag.lastIndex = match.index + match[0].length;
    let close;
    while (depth > 0 && (close = tag.exec(html))) depth += close[1] ? -1 : 1;
    bodies.push(html.slice(match.index + match[0].length, close ? close.index : html.length));
  }
  return bodies;
}

function render(props) {
  return renderToStaticMarkup(<WeeklyReportView state={state} now={NOW} {...props} />);
}

describe("weekly report notifications have no interactive children", () => {
  const cases = {
    "Undo after Submit": { undo: { id: 3, message: "You can undo this for 10 seconds." } },
    '"Open existing" for a duplicate name': { targetName: "acme" },
    "near-duplicate conflict": {
      targetName: "Globex Sytsems",
      conflict: { code: "similar_target", message: "This looks like a target you already reported on.", suggestions: [{ id: 9, target_name: "Globex Systems" }] },
    },
  };

  for (const [name, props] of Object.entries(cases)) {
    it(name, () => {
      const html = render(props);
      const bodies = notificationBodies(html);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body).not.toMatch(/<(button|a|input|select|textarea)\b/);
      }
    });
  }

  it("still offers the actions beside the notification", () => {
    expect(render(cases["Undo after Submit"])).toMatch(/rpt-weekly__notice-actions[\s\S]*Undo/);
    expect(render(cases['"Open existing" for a duplicate name'])).toContain("Open existing");
    const conflict = render(cases["near-duplicate conflict"]);
    expect(conflict).toContain("Open “Globex Systems”");
    expect(conflict).toContain("It&#x27;s a different target");
  });
});
