// Motion and visual-language probes (UI overhaul plan §2.4, §7.5 WS-I, §7.6)
// on the four surfaces: website, Console (Learn), Console Admin, back office.
//
//   - 0 transitions/animations of layout or paint-heavy properties
//     (only transform and opacity move; colour stays short)
//   - reduced motion: 0 infinite animations, 0 translate entrances
//   - normal motion: at most 2 concurrent loops (live ping, shimmer stop after 3)
//   - at most 1 champagne-filled element in the viewport
//   - Console and back office: at most 2 corner radii (0 and pill)
//   - IBM Plex Sans is the computed and loaded font
import { expect, test } from "./helpers.mjs";
import { MOTION_PAGES } from "./visual/pages.mjs";
import {
  probeChampagne,
  probeFonts,
  probeInfiniteAnimations,
  probeLayoutMotion,
  probeRadii,
  probeTranslateEntrances,
  RECORD_MOTION_INIT,
} from "./visual/probes.mjs";
import { stagePage } from "./visual/stage.mjs";

const APP_SURFACES = new Set(["student", "staff", "backoffice", "nocourse", "instructorOn", "instructorOff"]);

for (const entry of MOTION_PAGES) {
  test.describe(`motion: ${entry.id}`, () => {
    test("normal motion: only transform/opacity move, loops bounded, one champagne action, Plex", async ({ page, context, control }) => {
      const { placeholder } = await stagePage({ page, context, control }, entry);
      if (placeholder) test.info().annotations.push({ type: "transition", description: `placeholder (${placeholder})` });

      expect.soft(await page.evaluate(probeLayoutMotion), "layout/paint-property transitions or keyframes").toEqual([]);
      const loops = await page.evaluate(probeInfiniteAnimations);
      expect.soft(loops.length, `concurrent infinite loops: ${loops.join(" | ")}`).toBeLessThanOrEqual(2);
      const champagne = await page.evaluate(probeChampagne);
      expect.soft(champagne.length, `champagne-filled elements: ${champagne.join(" | ")}`).toBeLessThanOrEqual(1);
      if (APP_SURFACES.has(entry.persona)) {
        const radii = await page.evaluate(probeRadii);
        const extra = Object.keys(radii).filter((key) => !["0", "pill"].includes(key));
        expect.soft(extra, `corner radii other than 0 and pill: ${JSON.stringify(radii)}`).toEqual([]);
      }
      const fonts = await page.evaluate(probeFonts);
      expect.soft(fonts.body, "body font").toMatch(/^"?IBM Plex Sans/);
      if (fonts.heading) expect.soft(fonts.heading, "h1 font").toMatch(/^"?IBM Plex Sans/);
      expect.soft(fonts.plexLoaded, "IBM Plex Sans loaded").toBe(true);
    });

    test.describe("reduced motion", () => {
      test.use({ reducedMotion: "reduce" });

      test("no infinite animations, no translate entrances", async ({ page, context, control }) => {
        await page.addInitScript(RECORD_MOTION_INIT);
        const { placeholder } = await stagePage({ page, context, control }, entry);
        if (placeholder) test.info().annotations.push({ type: "transition", description: `placeholder (${placeholder})` });
        expect.soft(await page.evaluate(probeInfiniteAnimations), "infinite animations under reduced motion").toEqual([]);
        expect.soft(await page.evaluate(probeTranslateEntrances), "translate entrances under reduced motion").toEqual([]);
      });
    });
  });
}

// The Profile / avatar-menu "Reduce motion" toggle (WCAG 2.3.3) is remembered
// on the device (localStorage "sc.motion") and applied as
// :root[data-motion="reduce"]: the same final, still state as the OS setting,
// without the OS setting.
test("motion: the Reduce motion preference (data-motion=reduce) stops every loop on the Console", async ({ page, context, control }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("sc.motion", "reduce");
    } catch {
      // storage blocked: the assertion below reports it
    }
  });
  await page.addInitScript(RECORD_MOTION_INIT);
  await stagePage({ page, context, control }, { id: "student-home", persona: "student", path: "/console" });
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  expect.soft(await page.evaluate(probeInfiniteAnimations), "infinite animations with data-motion=reduce").toEqual([]);
  expect.soft(await page.evaluate(probeTranslateEntrances), "translate entrances with data-motion=reduce").toEqual([]);
});
