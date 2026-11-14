// Child-process helpers: every process the stack starts is tracked, logged to
// a file and killed as a whole tree on teardown (taskkill /T on Windows,
// a process group elsewhere), so a run never leaves orphans behind.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const tracked = new Set();
const isWindows = process.platform === "win32";

export function startProcess(name, command, args, { cwd, env, logDir, onLine } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${name}.log`);
  const out = fs.createWriteStream(logFile, { flags: "a" });
  out.write(`\n$ ${command} ${args.join(" ")}\n  (cwd ${cwd})\n`);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: !isWindows,
    shell: false,
  });
  const record = { name, child, logFile, exited: false, code: null };
  tracked.add(record);
  const forward = (chunk) => {
    out.write(chunk);
    if (onLine) {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim()) onLine(line);
    }
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("exit", (code, signal) => {
    record.exited = true;
    record.code = code ?? signal;
    out.write(`\n[exit ${code ?? signal}]\n`);
    out.end();
    tracked.delete(record);
  });
  child.on("error", (error) => {
    out.write(`\n[spawn error ${error.message}]\n`);
  });
  return record;
}

export function runToCompletion(name, command, args, { cwd, env, logDir, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const record = startProcess(name, command, args, { cwd, env, logDir });
    const timer = setTimeout(() => {
      killTree(record);
      reject(new Error(`${name} timed out after ${timeoutMs} ms (log: ${record.logFile})`));
    }, timeoutMs);
    record.child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(record);
      else reject(new Error(`${name} exited with ${code} (log: ${record.logFile})`));
    });
  });
}

export function killTree(record) {
  const pid = record?.child?.pid;
  if (!pid || record.exited) return;
  try {
    if (isWindows) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function killAll() {
  for (const record of [...tracked]) killTree(record);
}

/** Kill every tracked tree and wait (bounded) until each child has exited. */
export async function killAllAndWait(timeoutMs = 10_000) {
  const records = [...tracked];
  for (const record of records) killTree(record);
  const deadline = Date.now() + timeoutMs;
  while (tracked.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return [...tracked].map((record) => ({ name: record.name, pid: record.child.pid }));
}

export function trackedProcesses() {
  return [...tracked].map((record) => ({ name: record.name, pid: record.child.pid }));
}

export async function waitForHttp(url, { timeoutMs = 120_000, intervalMs = 250, record = null, accept = (status) => status < 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (record?.exited) throw new Error(`${record.name} exited (${record.code}) before ${url} answered; see ${record.logFile}`);
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (accept(response.status)) return response.status;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

export function portIsFree(port, host = "127.0.0.1") {
  return new Promise(async (resolve) => {
    const net = await import("node:net");
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}
