// Visual regression of every page in the UI overhaul page list (plan
// Appendix A.4) at 390x844 ("mobile") and 1440x900 ("desktop").
//
// Viewport screenshots, never full-page (full-page capture produced the
// "content under the side nav" artifact the audits found). Reduced motion,
// frozen server and browser clocks, a fresh seed per page, 1% pixel budget.
//
// Baselines live in tests/visual/baselines/<project>/<page>.png and are
// accepted only after the design director has reviewed them:
//   node run.mjs tests/visual.spec.mjs                         compare (pages without a baseline only run the language checks)
//   node run.mjs tests/visual.spec.mjs --update-snapshots      write/refresh baselines after review
//   E2E_SHOTS_DIR=<dir> node run.mjs tests/visual.spec.mjs     also write review copies <dir>/<page>-<width>.png
// A page whose module is still the WS-0 placeholder is skipped (no baseline of a placeholder).
import fs from "node:fs";

import { expect, test } from "./helpers.mjs";
import { PAGES } from "./visual/pages.mjs";
import { probeChampagne, probeRadii } from "./visual/probes.mjs";
import { MASK_COLOR, saveReviewShot, stagePage } from "./visual/stage.mjs";

test.use({ reducedMotion: "reduce" });

// Content that legitimately differs between runs (media frames, embeds, the
// moving anti-piracy watermark over the player) is masked.
const MASK = ["video", "canvas", "iframe", "[data-visual-mask]", ".pointer-events-none.absolute.inset-0.z-10.select-none"];
// Console and back office: corners are 0, or pill for tags/avatars/toggles (plan §2.1).
const APP_PERSONAS = new Set(["student", "nocourse", "instructorOff", "instructorOn", "staff", "backoffice"]);

for (const entry of PAGES) {
  test(`visual: ${entry.id} (${entry.note})`, async ({ page, context, control }, testInfo) => {
    const { placeholder } = await stagePage({ page, context, control }, entry);
    const mask = MASK.map((selector) => page.locator(selector));
    await saveReviewShot(page, testInfo, entry.id, { mask });
    test.skip(Boolean(placeholder), `page module is still the WS-0 placeholder (${placeholder})`);

    // Visual language on every page (plan §7.6), checked whether or not a baseline exists:
    // at most one champagne-filled element in the viewport, no sideways page scroll,
    // and (Console, back office) only the two corner radii.
    const champagne = await page.evaluate(probeChampagne);
    expect.soft(champagne.length, `champagne-filled elements in the viewport: ${champagne.join(" | ")}`).toBeLessThanOrEqual(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, "horizontal overflow in px").toBeLessThanOrEqual(1);
    if (APP_PERSONAS.has(entry.persona)) {
      const radii = await page.evaluate(probeRadii);
      const extra = Object.keys(radii).filter((key) => !["0", "pill"].includes(key));
      expect.soft(extra, `corner radii other than 0 and pill: ${JSON.stringify(radii)}`).toEqual([]);
    }

    const name = `${entry.id}.png`;
    const updating = ["all", "changed"].includes(testInfo.config.updateSnapshots);
    if (!updating && !fs.existsSync(testInfo.snapshotPath(name))) {
      // Not a skip: the language checks above still ran. Baselines are accepted after design review.
      testInfo.annotations.push({ type: "no-baseline", description: "no accepted baseline yet (run with --update-snapshots after review)" });
      return;
    }
    await expect(page).toHaveScreenshot(name, { mask, maskColor: MASK_COLOR });
  });
}
