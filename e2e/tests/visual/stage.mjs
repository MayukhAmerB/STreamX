// Shared staging for the quality specs (visual, a11y, motion). OWNER: WS-I.
//
// stagePage(): fresh seed at a frozen instant, feature switches, fixtures,
// sign-in as the page's persona, visit, then wait until the page is calm
// (fonts loaded, no skeleton/loader, DOM quiet). Deterministic on purpose:
// same seed, same server clock, same browser clock, reduced motion.
import fs from "node:fs";
import path from "node:path";

import { expect, signIn, signInToBackOffice } from "../helpers.mjs";
import { resolvePath } from "./pages.mjs";

/** Masked regions (live media, embeds) are painted in the layer-01 grey, not Playwright's magenta. */
export const MASK_COLOR = "#262626";

/** The instant every quality spec runs at: Wednesday 18 Nov 2026, 11:00 IST. */
export const FROZEN_NOW = "2026-11-18T11:00:00+05:30";

/**
 * Who looks at a page. `user` is a manifest key; `features` are set through
 * the audited feature service before signing in.
 */
export const PERSONAS = {
  public: { user: null },
  student: { user: "student1" },
  nocourse: { user: "outsider" },
  instructorOff: { user: "instructor", features: { teaching: false } },
  instructorOn: { user: "instructor", features: { teaching: true } },
  staff: { user: "admin" },
  backoffice: { user: "admin", backOffice: true },
};

// Anything still loading. Carbon skeletons/loaders, our own skeletons, and
// any region that says it is busy.
const LOADING_SELECTOR = [
  '[aria-busy="true"]',
  ".cds--skeleton",
  ".cds--skeleton__text",
  ".cds--loading:not(.cds--loading--stop)",
  ".sc-skeleton",
  "[data-skeleton]",
].join(", ");

/** The page module is still the WS-0 placeholder (its owner has not landed it yet). */
export async function placeholderOwner(page) {
  const node = page.locator("[data-placeholder-owner]").first();
  if (!(await node.count())) return null;
  return (await node.getAttribute("data-placeholder-owner")) || "unknown";
}

/** Wait until the page is calm enough to measure or photograph. */
export async function settle(page, { quietMs = 400, maxMs = 6_000 } = {}) {
  await page.waitForLoadState("load");
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  await page
    .waitForFunction((selector) => !document.querySelector(selector), LOADING_SELECTOR, { timeout: 15_000 })
    .catch(() => {});
  // DOM quiet: no mutation for `quietMs` (bounded by `maxMs` for live tickers).
  await page.evaluate(
    ({ quietMs, maxMs }) =>
      new Promise((resolve) => {
        let timer;
        const done = () => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(cap);
          resolve();
        };
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(done, quietMs);
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        timer = setTimeout(done, quietMs);
        const cap = setTimeout(done, maxMs);
      }),
    { quietMs, maxMs }
  );
}

/**
 * Seed, configure, sign in and open `entry` (see pages.mjs). Returns
 * `{ manifest, url, placeholder }`.
 */
export async function stagePage({ page, context, control }, entry, { now = FROZEN_NOW } = {}) {
  const persona = PERSONAS[entry.persona];
  if (!persona) throw new Error(`unknown persona ${entry.persona}`);
  const manifest = await control.reset({ freeze: now });
  if (persona.features) await control.fixture("features", { set: persona.features });
  for (const name of entry.fixtures || []) {
    const result = await control.fixture(name);
    const failed = Object.entries(result?.created || {}).filter(([, value]) => value && value.error);
    expect(failed, `fixture ${name}: ${JSON.stringify(failed)}`).toEqual([]);
  }
  await page.clock.setFixedTime(new Date(now));
  if (persona.backOffice) {
    await signInToBackOffice(page, manifest, persona.user);
  } else if (persona.user) {
    await signIn(context, manifest, persona.user);
  }
  const url = resolvePath(entry, manifest);
  const response = await page.goto(url);
  if (entry.persona === "backoffice") expect(response?.status(), `${url} answered`).toBeLessThan(500);
  await settle(page);
  return { manifest, url, placeholder: await placeholderOwner(page) };
}

/**
 * Review copy of a viewport screenshot (not a baseline): written to
 * $E2E_SHOTS_DIR/<project>/<id>.png when E2E_SHOTS_DIR is set, so a reviewer
 * can look at every page at 390 and 1440 without accepting baselines.
 */
export async function saveReviewShot(page, testInfo, id, { mask = [], maskColor = MASK_COLOR } = {}) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return null;
  const width = testInfo.project.use?.viewport?.width || page.viewportSize()?.width || 0;
  const file = path.join(dir, `${id}-${width}.png`);
  fs.mkdirSync(dir, { recursive: true });
  // Same masks as the baseline comparison, so the reviewer sees what is compared.
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", scale: "css", mask, maskColor });
  return file;
}
