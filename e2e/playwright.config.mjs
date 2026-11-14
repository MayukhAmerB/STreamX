// Playwright configuration for the end-to-end journeys.
// The stack is started by run.mjs (or by hand with `node stack.mjs`), which
// passes E2E_WEB_URL, E2E_LABS_URL, E2E_CONTROL_TOKEN and E2E_RESULTS_DIR.
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const resultsDir = process.env.E2E_RESULTS_DIR || path.resolve("test-results-local");

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.mjs$/,
  // One server, one database, one clock: journeys run one at a time and each
  // starts from a freshly seeded database.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: path.join(resultsDir, "artifacts"),
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(resultsDir, "html-report"), open: "never" }],
    ["json", { outputFile: path.join(resultsDir, "results.json") }],
  ],
  use: {
    baseURL: process.env.E2E_WEB_URL || "http://localhost:4273",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      // Chromium with a phone viewport (390 px wide, touch, mobile UA).
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
  ],
});
