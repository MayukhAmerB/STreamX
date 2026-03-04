import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== "string") return false;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function isIpv4(ip) {
  if (!ip || typeof ip !== "string") return false;
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  return parts.every((p) => p >= 0 && p <= 255);
}

function parseDotenvFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const values = {};
    for (const rawLine of raw.split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("export ")) {
        line = line.slice("export ".length).trim();
      }
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (!key) continue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}

function extractHostFromUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.hostname || "";
  } catch {
    try {
      const parsed = new URL(`http://${value}`);
      return parsed.hostname || "";
    } catch {
      return "";
    }
  }
}

function detectLanIpv4() {
  const interfaces = networkInterfaces();
  const candidates = [];
  for (const rows of Object.values(interfaces)) {
    for (const row of rows || []) {
      if (row.family !== "IPv4" || row.internal) continue;
      candidates.push(row.address);
    }
  }
  const privateCandidate = candidates.find((ip) => isPrivateIpv4(ip));
  return privateCandidate || candidates[0] || "";
}

function replaceOrInsertRtcField(content, key, value) {
  const fieldPattern = new RegExp(`^(\\s*${key}:\\s*).*$`, "m");
  if (fieldPattern.test(content)) {
    return content.replace(fieldPattern, `$1${value}`);
  }
  const rtcPattern = /^rtc:\s*$/m;
  if (!rtcPattern.test(content)) {
    return `${content.trimEnd()}\nrtc:\n  ${key}: ${value}\n`;
  }
  return content.replace(rtcPattern, `rtc:\n  ${key}: ${value}`);
}

const deploymentModeRaw = (process.env.LIVEKIT_DEPLOYMENT_MODE || "auto").trim().toLowerCase();
const projectRoot = process.cwd();
const fileEnv = {
  ...parseDotenvFile(path.join(projectRoot, ".env")),
  ...parseDotenvFile(path.join(projectRoot, "backend", ".env")),
};

const configuredLivekitPublicUrl = (
  process.env.LIVEKIT_PUBLIC_URL ||
  fileEnv.LIVEKIT_PUBLIC_URL ||
  ""
).trim();
const configuredFrontendPublicOrigin = (
  process.env.FRONTEND_PUBLIC_ORIGIN ||
  fileEnv.FRONTEND_PUBLIC_ORIGIN ||
  ""
).trim();
const configuredFrontendUrl = (
  process.env.FRONTEND_URL ||
  fileEnv.FRONTEND_URL ||
  ""
).trim();
const configuredFrontendHost =
  extractHostFromUrl(configuredFrontendPublicOrigin) || extractHostFromUrl(configuredFrontendUrl);

const configuredNodeIp = (
  process.env.LIVEKIT_NODE_IP ||
  fileEnv.LIVEKIT_NODE_IP ||
  ""
).trim();
const derivedNodeIpFromUrls = [
  extractHostFromUrl(configuredLivekitPublicUrl),
  extractHostFromUrl(configuredFrontendPublicOrigin),
  extractHostFromUrl(configuredFrontendUrl),
].find((host) => isIpv4(host));

const configuredUdpPort = String(process.env.LIVEKIT_UDP_PORT || "7882").trim();

if (!/^\d+$/.test(configuredUdpPort)) {
  console.error(`[infra] Invalid LIVEKIT_UDP_PORT value: "${configuredUdpPort}"`);
  process.exit(1);
}

const detectedLanIp = detectLanIpv4();
let effectiveMode = deploymentModeRaw;
if (!["auto", "lan", "local", "cloud"].includes(effectiveMode)) {
  effectiveMode = "auto";
}
if (effectiveMode === "auto") {
  effectiveMode = configuredNodeIp && !isPrivateIpv4(configuredNodeIp) ? "cloud" : "lan";
}
if (effectiveMode === "local") {
  effectiveMode = "lan";
}

const resolvedNodeIp = configuredNodeIp || derivedNodeIpFromUrls || detectedLanIp;
if (!resolvedNodeIp) {
  console.error(
    "[infra] Unable to detect LIVEKIT_NODE_IP automatically. Set LIVEKIT_NODE_IP and retry."
  );
  process.exit(1);
}

if (effectiveMode === "cloud" && isPrivateIpv4(resolvedNodeIp)) {
  console.error(
    `[infra] LIVEKIT_DEPLOYMENT_MODE=cloud requires a public LIVEKIT_NODE_IP. Current value: ${resolvedNodeIp}`
  );
  process.exit(1);
}

const useExternalIp = parseBoolean(
  process.env.LIVEKIT_USE_EXTERNAL_IP,
  effectiveMode === "cloud"
);

const livekitTemplatePath = path.join(projectRoot, "infra", "livekit.yaml");
const generatedConfigPath = path.join(projectRoot, "infra", "livekit.runtime.yaml");
const composeConfigPath = "./infra/livekit.runtime.yaml";

const livekitTemplate = readFileSync(livekitTemplatePath, "utf8");
let livekitRuntimeConfig = livekitTemplate;
livekitRuntimeConfig = replaceOrInsertRtcField(livekitRuntimeConfig, "udp_port", configuredUdpPort);
livekitRuntimeConfig = replaceOrInsertRtcField(
  livekitRuntimeConfig,
  "use_external_ip",
  useExternalIp ? "true" : "false"
);
writeFileSync(generatedConfigPath, livekitRuntimeConfig, "utf8");

const env = {
  ...process.env,
  LIVEKIT_NODE_IP: resolvedNodeIp,
  LIVEKIT_UDP_PORT: configuredUdpPort,
  LIVEKIT_CONFIG_FILE: composeConfigPath,
};

console.log(
  `[infra] mode=${effectiveMode} LIVEKIT_NODE_IP=${resolvedNodeIp} UDP=${configuredUdpPort} use_external_ip=${useExternalIp}`
);
if (
  isIpv4(configuredFrontendHost) &&
  isPrivateIpv4(configuredFrontendHost) &&
  configuredFrontendHost !== resolvedNodeIp
) {
  console.warn(
    `[infra] FRONTEND_URL host (${configuredFrontendHost}) differs from LIVEKIT_NODE_IP (${resolvedNodeIp}). This can break LAN WebRTC.`
  );
}
if (effectiveMode === "cloud" && !(process.env.LIVEKIT_PUBLIC_URL || "").trim()) {
  console.warn(
    "[infra] LIVEKIT_PUBLIC_URL is not set. Set it in backend env for shareable cloud meeting payloads."
  );
}

const dockerArgs = [
  "compose",
  "up",
  "-d",
  "livekit",
  "redis",
  "livekit-egress",
  "owncast",
];

const child = spawn("docker", dockerArgs, {
  env,
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
