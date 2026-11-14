// Accessibility of every page in the UI overhaul page list (plan Appendix
// A.4, §7.5 WS-I, §7.6) at 390 and 1440:
//   - axe-core: 0 serious or critical violations (WCAG 2.0/2.1/2.2 A + AA rules)
//   - target size: interactive targets >= 24x24 CSS px or spaced (WCAG 2.5.8)
//   - no horizontal page scroll
// Each check is soft, so one run reports every problem on the page.
import fs from "node:fs";

import { expect, test } from "./helpers.mjs";
import { PAGES } from "./visual/pages.mjs";
import { AXE_PATH, probeHorizontalOverflow, probeTargetSize } from "./visual/probes.mjs";
import { stagePage } from "./visual/stage.mjs";

const AXE_SOURCE = fs.readFileSync(AXE_PATH, "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function runAxe(page) {
  // Evaluated over CDP (not a <script> tag): works whatever the page's CSP says.
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: tags },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter((violation) => ["serious", "critical"].includes(violation.impact))
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 5).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary || "").split("\n").slice(1, 2).join(" ").trim()}`),
        count: violation.nodes.length,
      }));
  }, AXE_TAGS);
}

for (const entry of PAGES) {
  test(`a11y: ${entry.id}`, async ({ page, context, control }, testInfo) => {
    const { placeholder } = await stagePage({ page, context, control }, entry);
    if (placeholder) testInfo.annotations.push({ type: "transition", description: `page module is still a placeholder (${placeholder})` });

    const violations = await runAxe(page);
    if (violations.length) {
      await testInfo.attach("axe-violations.json", { body: JSON.stringify(violations, null, 2), contentType: "application/json" });
    }
    expect.soft(violations.map((item) => `${item.impact} ${item.id} (${item.count}): ${item.help} -> ${item.nodes[0]}`), "axe serious/critical").toEqual([]);

    const small = await page.evaluate(probeTargetSize);
    expect.soft(small, "targets under 24x24 px without spacing (WCAG 2.5.8)").toEqual([]);

    const { overflow, offenders } = await page.evaluate(probeHorizontalOverflow);
    expect.soft(overflow, `horizontal page scroll (px); widest: ${offenders.join(" | ")}`).toBe(0);
  });
}
