// Runner: start the stack, run every journey (desktop + mobile), write the
// reports, tear everything down.
//
//   node e2e/run.mjs                      all journeys, both projects
//   node e2e/run.mjs --project=desktop    any extra args go to `playwright test`
//   node e2e/run.mjs tests/live-class.spec.mjs
//
// Output: <scratch>/e2e-results/<run>/
//   html-report/index.html   Playwright HTML report
//   results.json             Playwright JSON report
//   summary.json             pass/fail per journey and project, timings, bugs
//   artifacts/               failure screenshots, traces (retain-on-failure)
//   logs/                    django, web, labs, stubs, build logs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { killAll, killAllAndWait, portIsFree, startProcess, trackedProcesses } from "./lib/procs.mjs";
import { PORTS, scratchRoot, startStack } from "./stack.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runId = process.env.E2E_RUN_ID || new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const runDir = path.join(scratchRoot(), "e2e-results", runId);
fs.mkdirSync(runDir, { recursive: true });
const log = (line) => {
  const text = `[e2e] ${line}`;
  console.log(text);
  fs.appendFileSync(path.join(runDir, "runner.log"), `${new Date().toISOString()} ${text}\n`);
};

let stack = null;
let stopping = false;
async function teardown(reason) {
  if (stopping) return;
  stopping = true;
  log(`tearing down (${reason})`);
  try {
    await stack?.stop();
  } finally {
    await killAllAndWait();
  }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    await teardown(signal);
    process.exit(130);
  });
}
process.on("exit", () => killAll());

function collectSpecs(suite, out = [], titlePath = []) {
  const titles = suite.title ? [...titlePath, suite.title] : titlePath;
  for (const spec of suite.specs || []) {
    for (const item of spec.tests || []) {
      const results = item.results || [];
      const last = results[results.length - 1] || {};
      out.push({
        file: spec.file,
        journey: spec.title,
        project: item.projectName,
        status: item.status === "expected" ? "passed" : item.status === "skipped" ? "skipped" : "failed",
        duration_ms: results.reduce((sum, result) => sum + (result.duration || 0), 0),
        errors: (last.errors || []).map((error) => String(error.message || "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 3).join(" ")).slice(0, 6),
        annotations: (item.annotations || []).filter((note) => ["bug", "metric", "skip-reason"].includes(note.type)),
        attachments: (last.attachments || []).filter((attachment) => attachment.path).map((attachment) => attachment.path),
      });
    }
  }
  for (const child of suite.suites || []) collectSpecs(child, out, titles);
  return out;
}

async function main() {
  const started = Date.now();
  log(`run ${runId} -> ${runDir}`);
  stack = await startStack({ runDir, log });
  fs.writeFileSync(
    path.join(runDir, "stack.json"),
    JSON.stringify({ urls: stack.urls, ports: stack.ports, runDir, dataDir: stack.dataDir }, null, 2)
  );

  const extraArgs = process.argv.slice(2);
  const playwright = startProcess(
    "playwright",
    process.execPath,
    [path.join(here, "node_modules", "@playwright", "test", "cli.js"), "test", "--config", path.join(here, "playwright.config.mjs"), ...extraArgs],
    {
      cwd: here,
      logDir: stack.logDir,
      env: {
        E2E_WEB_URL: stack.urls.web,
        E2E_LABS_URL: stack.urls.labs,
        E2E_OWNCAST_URL: stack.urls.owncast,
        E2E_LIVEKIT_URL: stack.urls.livekit,
        E2E_CONTROL_TOKEN: stack.controlToken,
        E2E_RESULTS_DIR: runDir,
        FORCE_COLOR: "0",
      },
      onLine: (line) => console.log(`  ${line}`),
    }
  );
  const exitCode = await new Promise((resolve) => playwright.child.on("exit", (code) => resolve(code ?? 1)));

  let specs = [];
  const resultsFile = path.join(runDir, "results.json");
  if (fs.existsSync(resultsFile)) {
    const report = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    specs = (report.suites || []).flatMap((suite) => collectSpecs(suite));
  }
  await teardown("journeys finished");

  // No orphans: every tracked process is gone and every port is free again.
  const leftovers = trackedProcesses();
  const busyPorts = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portIsFree(port))) busyPorts.push(`${name}:${port}`);

  const summary = {
    run: runId,
    run_dir: runDir,
    html_report: path.join(runDir, "html-report", "index.html"),
    started_at: new Date(started).toISOString(),
    duration_s: Math.round((Date.now() - started) / 1000),
    playwright_exit_code: exitCode,
    totals: {
      passed: specs.filter((item) => item.status === "passed").length,
      failed: specs.filter((item) => item.status === "failed").length,
      skipped: specs.filter((item) => item.status === "skipped").length,
    },
    journeys: specs,
    teardown: { leftover_processes: leftovers, busy_ports: busyPorts },
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  log(`summary: ${summary.totals.passed} passed, ${summary.totals.failed} failed, ${summary.totals.skipped} skipped`);
  for (const item of specs) log(`  ${item.status.padEnd(7)} [${item.project}] ${item.journey}`);
  log(`HTML report: ${summary.html_report}`);
  log(`summary.json: ${path.join(runDir, "summary.json")}`);
  if (leftovers.length || busyPorts.length) log(`WARNING: teardown left ${JSON.stringify(summary.teardown)}`);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    log(`FAILED: ${error.stack || error}`);
    await teardown("error");
    process.exit(1);
  });
