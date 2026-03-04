import net from "node:net";

const [, , rawUrl, rawTimeoutMs] = process.argv;

if (!rawUrl) {
  console.error("[wait-for-http] Missing URL argument.");
  process.exit(1);
}

const timeoutMs = Number.parseInt(rawTimeoutMs || "60000", 10);
const pollIntervalMs = 500;
const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 60000);
const parsedUrl = new URL(rawUrl);
const host = parsedUrl.hostname;
const port = Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canReachTcp(hostname, portNumber) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect(portNumber, hostname);
  });
}

async function main() {
  process.stdout.write(`[wait-for-http] Waiting for ${rawUrl}`);
  while (Date.now() < deadline) {
    if (await canReachTcp(host, port)) {
      process.stdout.write("\n");
      console.log(`[wait-for-http] Ready: ${rawUrl}`);
      process.exit(0);
      return;
    }
    process.stdout.write(".");
    await sleep(pollIntervalMs);
  }
  process.stdout.write("\n");
  console.error(`[wait-for-http] Timed out waiting for ${rawUrl}`);
  process.exit(1);
}

main();
