// One-command local stack for the end-to-end journeys.
//
//   node e2e/stack.mjs            start everything, print the URLs, Ctrl+C stops it
//   (run.mjs imports startStack() and runs the journeys against it)
//
// What it starts (all on localhost, nothing external is contacted):
//   stubs (in this process)  Owncast (status + fixture HLS), LiveKit Twirp API,
//                            clamd (TCP), and an nginx-like gateway that applies
//                            the production /media/ allowlist and X-Accel-Redirect
//   Django                   runserver on a dedicated SQLite DB,
//                            DJANGO_SETTINGS_MODULE=config.settings.e2e, E2E=1
//   web                      `vite preview` of the production build, /api -> gateway
//   labs                     OSINTCTF/server.js on :8092, LABS_LMS_API_BASE -> web /api
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { killAllAndWait, portIsFree, runToCompletion, startProcess, waitForHttp } from "./lib/procs.mjs";
import { createClamdStub } from "./stubs/clamd.mjs";
import { createGateway } from "./stubs/gateway.mjs";
import { closeServer, listen } from "./stubs/http-util.mjs";
import { createLivekitStub } from "./stubs/livekit.mjs";
import { createOwncastStub } from "./stubs/owncast.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, "..");
const BACKEND = path.join(REPO, "backend");
const FRONTEND = path.join(REPO, "frontend");
const LABS = path.join(REPO, "OSINTCTF");
const DEFAULT_SCRATCH = "C:\\Temp\\claude\\8ec2e9fdced74731\\7229cda4-9381-4581-83a1-6384efd2c5a7\\scratchpad";

export const PORTS = {
  django: Number(process.env.E2E_DJANGO_PORT || 18000),
  gateway: Number(process.env.E2E_GATEWAY_PORT || 18080),
  web: Number(process.env.E2E_WEB_PORT || 4273),
  labs: Number(process.env.E2E_LABS_PORT || 8092),
  owncast: Number(process.env.E2E_OWNCAST_PORT || 18081),
  livekit: Number(process.env.E2E_LIVEKIT_PORT || 18082),
  clamd: Number(process.env.E2E_CLAMD_PORT || 13310),
};

export const URLS = {
  web: `http://localhost:${PORTS.web}`,
  labs: `http://localhost:${PORTS.labs}`,
  django: `http://127.0.0.1:${PORTS.django}`,
  gateway: `http://127.0.0.1:${PORTS.gateway}`,
  owncast: `http://localhost:${PORTS.owncast}`,
  livekit: `http://localhost:${PORTS.livekit}`,
};

export function scratchRoot() {
  return process.env.E2E_SCRATCH_DIR || DEFAULT_SCRATCH;
}

function pythonPath() {
  if (process.env.E2E_PYTHON) return process.env.E2E_PYTHON;
  const candidates = [path.join(REPO, ".venv", "Scripts", "python.exe"), path.join(REPO, ".venv", "bin", "python")];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "python";
}

function hashTree(roots, { skip = () => false } = {}) {
  const hash = crypto.createHash("sha256");
  const walk = (target) => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        const child = path.join(target, entry);
        if (!skip(child, entry)) walk(child);
      }
      return;
    }
    hash.update(path.relative(REPO, target));
    hash.update(fs.readFileSync(target));
  };
  for (const root of roots) walk(root);
  return hash.digest("hex").slice(0, 16);
}

function djangoEnv(dataDir, controlToken) {
  return {
    E2E: "1",
    DJANGO_SETTINGS_MODULE: "config.settings.e2e",
    E2E_DATA_DIR: dataDir,
    E2E_FIXTURES_DIR: path.join(here, "fixtures"),
    E2E_CONTROL_TOKEN: controlToken,
    E2E_DJANGO_PORT: String(PORTS.django),
    E2E_GATEWAY_PORT: String(PORTS.gateway),
    E2E_WEB_PORT: String(PORTS.web),
    E2E_LABS_PORT: String(PORTS.labs),
    E2E_OWNCAST_PORT: String(PORTS.owncast),
    E2E_LIVEKIT_PORT: String(PORTS.livekit),
    E2E_CLAMD_PORT: String(PORTS.clamd),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    // Never inherit a developer's production-ish settings.
    APP_ENV: "development",
  };
}

async function prepareDatabase({ dataDir, cacheDir, logDir, controlToken, log }) {
  // The template only depends on the migration files.
  const migrationsHash = hashTree([path.join(BACKEND, "apps")], {
    skip: (child, entry) =>
      entry === "__pycache__" ||
      (fs.statSync(child).isFile() && !(child.includes(`${path.sep}migrations${path.sep}`) && entry.endsWith(".py"))),
  });
  const template = path.join(cacheDir, `db-${migrationsHash}.sqlite3`);
  const target = path.join(dataDir, "e2e.sqlite3");
  if (!fs.existsSync(template) || process.env.E2E_REBUILD === "1") {
    log(`migrating a fresh SQLite template (${migrationsHash})...`);
    const scratchData = path.join(cacheDir, `migrate-${migrationsHash}`);
    fs.rmSync(scratchData, { recursive: true, force: true });
    fs.mkdirSync(scratchData, { recursive: true });
    await runToCompletion("migrate", pythonPath(), ["manage.py", "migrate", "--noinput", "-v", "0"], {
      cwd: BACKEND,
      env: djangoEnv(scratchData, controlToken),
      logDir,
      timeoutMs: 600_000,
    });
    fs.copyFileSync(path.join(scratchData, "e2e.sqlite3"), template);
    fs.rmSync(scratchData, { recursive: true, force: true });
  } else {
    log(`reusing migrated SQLite template ${path.basename(template)}`);
  }
  fs.copyFileSync(template, target);
}

async function buildFrontend({ cacheDir, logDir, log }) {
  const sourceHash = hashTree(
    [
      path.join(FRONTEND, "src"),
      path.join(FRONTEND, "public"),
      path.join(FRONTEND, "index.html"),
      path.join(FRONTEND, "vite.config.js"),
      path.join(FRONTEND, "package-lock.json"),
      path.join(FRONTEND, "tailwind.config.js"),
      path.join(FRONTEND, "postcss.config.js"),
      path.join(FRONTEND, ".env"),
    ],
    { skip: (_child, entry) => entry === "node_modules" || entry.endsWith(".test.js") || entry.endsWith(".test.jsx") }
  );
  // The labs port is baked into the build (login ?next= allowlist), so a
  // non-default port gets its own cached build.
  const labsPortSuffix = PORTS.labs === 8092 ? "" : `-labs${PORTS.labs}`;
  const outDir = path.join(cacheDir, `web-${sourceHash}${labsPortSuffix}`);
  if (fs.existsSync(path.join(outDir, "index.html")) && process.env.E2E_REBUILD !== "1") {
    log(`reusing frontend build ${path.basename(outDir)}`);
    return outDir;
  }
  log(`building the frontend (vite build -> ${outDir})...`);
  await runToCompletion(
    "vite-build",
    process.execPath,
    [path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", outDir, "--emptyOutDir"],
    {
      cwd: FRONTEND,
      env: {
        VITE_API_BASE_URL: "/api",
        VITE_FORCE_SAME_ORIGIN_API: "1",
        VITE_SITE_BRAND: "alsyed",
        VITE_TURNSTILE_SITE_KEY: "",
        VITE_DEV_LABS_PORTS: String(PORTS.labs),
      },
      logDir,
      timeoutMs: 900_000,
    }
  );
  return outDir;
}

/**
 * Start the whole stack. Returns { urls, ports, controlToken, runDir, dataDir, stubs, stop }.
 */
export async function startStack({ runDir, log = (line) => console.log(`[stack] ${line}`) } = {}) {
  const started = Date.now();
  runDir = runDir || path.join(scratchRoot(), "e2e-results", `stack-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const dataDir = path.join(runDir, "data");
  const logDir = path.join(runDir, "logs");
  const cacheDir = path.join(scratchRoot(), "e2e-cache");
  for (const dir of [dataDir, logDir, cacheDir]) fs.mkdirSync(dir, { recursive: true });
  for (const sub of ["media", "private_media", "private_quarantine", "recordings/class-recordings"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
  const controlToken = crypto.randomBytes(16).toString("hex");

  const busy = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portIsFree(port))) busy.push(`${name}:${port}`);
  if (busy.length) throw new Error(`Ports already in use: ${busy.join(", ")} (another stack still running?)`);

  const servers = [];
  const stop = async () => {
    await killAllAndWait();
    await Promise.all(servers.map((server) => closeServer(server)));
  };

  try {
    const stubLog = (line) => fs.appendFileSync(path.join(logDir, "stubs.log"), `${new Date().toISOString()} ${line}\n`);
    const owncast = createOwncastStub({ log: stubLog });
    const livekit = createLivekitStub({ owncast, log: stubLog });
    const clamd = createClamdStub({ log: stubLog });
    const gateway = createGateway({ djangoPort: PORTS.django, mediaRoot: path.join(dataDir, "media"), log: stubLog });
    servers.push(owncast.server, livekit.server, clamd.server, gateway.server);
    // Dual-stack: browsers resolve "localhost" to ::1 first.
    await listen(owncast.server, PORTS.owncast, "::");
    await listen(livekit.server, PORTS.livekit, "::");
    await listen(clamd.server, PORTS.clamd);
    await listen(gateway.server, PORTS.gateway);
    log(`stubs up: owncast :${PORTS.owncast}, livekit :${PORTS.livekit}, clamd :${PORTS.clamd}, gateway :${PORTS.gateway}`);

    const [, webDist] = await Promise.all([
      prepareDatabase({ dataDir, cacheDir, logDir, controlToken, log }),
      buildFrontend({ cacheDir, logDir, log }),
    ]);

    const django = startProcess(
      "django",
      pythonPath(),
      ["manage.py", "runserver", `127.0.0.1:${PORTS.django}`, "--noreload"],
      { cwd: BACKEND, env: djangoEnv(dataDir, controlToken), logDir }
    );
    const previewConfig = path.join(here, "vite.preview.config.mjs");
    const web = startProcess(
      "web",
      process.execPath,
      [
        path.join(FRONTEND, "node_modules", "vite", "bin", "vite.js"),
        "preview",
        "--config",
        previewConfig,
        "--outDir",
        webDist,
        "--host",
        "localhost",
        "--port",
        String(PORTS.web),
        "--strictPort",
      ],
      { cwd: FRONTEND, env: { E2E_GATEWAY_URL: URLS.gateway }, logDir }
    );
    const labs = startProcess("labs", process.execPath, [path.join(LABS, "server.js")], {
      cwd: LABS,
      env: { PORT: String(PORTS.labs), LABS_LMS_API_BASE: `${URLS.web}/api`, HOST: "127.0.0.1" },
      logDir,
    });

    await waitForHttp(`${URLS.django}/healthz`, { record: django, timeoutMs: 180_000 });
    await waitForHttp(`${URLS.web}/`, { record: web });
    await waitForHttp(`${URLS.web}/api/auth/config/`, { record: web });
    await waitForHttp(`${URLS.labs}/`, { record: labs });
    log(`stack ready in ${Math.round((Date.now() - started) / 1000)} s: web ${URLS.web}, labs ${URLS.labs}`);

    return {
      urls: URLS,
      ports: PORTS,
      controlToken,
      runDir,
      dataDir,
      logDir,
      stubs: { owncast, livekit, clamd, gateway },
      processes: { django, web, labs },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

// `node e2e/stack.mjs`: start it and keep it running until Ctrl+C.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const stack = await startStack();
  const env = path.join(stack.runDir, "stack.json");
  fs.writeFileSync(env, JSON.stringify({ urls: stack.urls, controlToken: stack.controlToken, runDir: stack.runDir }, null, 2));
  console.log(`[stack] control token in ${env}. Seed with: POST ${stack.urls.web}/api/__e2e__/reset/ (header X-E2E-Token)`);
  console.log("[stack] press Ctrl+C to stop");
  const shutdown = async () => {
    await stack.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
