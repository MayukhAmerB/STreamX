// Owncast stand-in: /api/status, a fixture HLS feed, the embed pages and the
// admin API the backend calls (stream key sync, chat). Journeys flip the feed
// online/offline through POST /__stub/state, like OBS connecting or dropping.
import { createServer, readJson, sendJson } from "./http-util.mjs";

const SEGMENTS = 4;
const TARGET_DURATION = 2;

function tsSegment(index) {
  // MPEG-TS-shaped bytes (188-byte packets starting with the 0x47 sync byte).
  const packets = 8;
  const buffer = Buffer.alloc(188 * packets, 0xff);
  for (let packet = 0; packet < packets; packet += 1) {
    buffer[packet * 188] = 0x47;
    buffer.write(`E2E-SEGMENT-${index}-${packet}`, packet * 188 + 4, "ascii");
  }
  return buffer;
}

export function createOwncastStub({ log = () => {} } = {}) {
  const state = {
    online: false,
    viewerCount: 0,
    streamTitle: "E2E class",
    lastConnectTime: "",
    lastDisconnectTime: "",
    connectCount: 0,
    sequence: 0,
    requests: [],
  };

  function setOnline(online) {
    const now = new Date().toISOString();
    if (online && !state.online) {
      state.connectCount += 1;
      state.lastConnectTime = now;
    }
    if (!online && state.online) state.lastDisconnectTime = now;
    state.online = Boolean(online);
  }

  function reset() {
    state.online = false;
    state.viewerCount = 0;
    state.lastConnectTime = "";
    state.lastDisconnectTime = "";
    state.connectCount = 0;
    state.sequence = 0;
    state.requests = [];
  }

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}`);
    if (state.requests.length > 200) state.requests.shift();
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (path === "/__stub/state") {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (body.reset) reset();
        if (typeof body.online === "boolean") setOnline(body.online);
        if (typeof body.viewerCount === "number") state.viewerCount = body.viewerCount;
        log(`owncast stub: online=${state.online}`);
      }
      return sendJson(res, 200, { ...state, requests: state.requests.slice(-20) });
    }
    if (path === "/api/status") {
      return sendJson(
        res,
        200,
        {
          online: state.online,
          viewerCount: state.viewerCount,
          streamTitle: state.streamTitle,
          lastConnectTime: state.lastConnectTime || null,
          lastDisconnectTime: state.lastDisconnectTime || null,
          serverTime: new Date().toISOString(),
          versionNumber: "0.1.3-e2e",
        },
        cors
      );
    }
    if (path === "/hls/stream.m3u8") {
      if (!state.online) return sendJson(res, 404, { error: "offline" }, cors);
      const body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720\n0/stream.m3u8\n";
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache", ...cors });
      return res.end(body);
    }
    if (path === "/hls/0/stream.m3u8") {
      if (!state.online) return sendJson(res, 404, { error: "offline" }, cors);
      state.sequence += 1;
      const first = state.sequence;
      const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${TARGET_DURATION}`, `#EXT-X-MEDIA-SEQUENCE:${first}`];
      for (let index = 0; index < SEGMENTS; index += 1) {
        lines.push(`#EXTINF:${TARGET_DURATION}.0,`, `seg-${first + index}.ts`);
      }
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache", ...cors });
      return res.end(`${lines.join("\n")}\n`);
    }
    const segment = path.match(/^\/hls\/0\/seg-(\d+)\.ts$/);
    if (segment) {
      const body = tsSegment(Number(segment[1]));
      res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length, ...cors });
      return res.end(body);
    }
    if (path.startsWith("/embed/")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(
        `<!doctype html><title>Owncast stub</title><body style="background:#111;color:#eee;font:14px sans-serif">Owncast stub ${path}</body>`
      );
    }
    if (path.startsWith("/api/admin/") || path.startsWith("/api/chat") || path.startsWith("/api/integrations/")) {
      if (req.method === "POST") await readJson(req);
      return sendJson(res, 200, { success: true, message: "ok", accessToken: "e2e-chat-token", users: [], messages: [] }, cors);
    }
    if (path.startsWith("/api/")) return sendJson(res, 200, {}, cors);
    return sendJson(res, 404, { error: "not found", path }, cors);
  });

  return { server, state, setOnline, reset };
}
