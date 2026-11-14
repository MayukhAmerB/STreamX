// nginx stand-in in front of Django, applying the production media contract
// (infra/hostinger/nginx/media.conf and alsyedinitiative.conf):
//   * /media/ is an ALLOWLIST: only the public folders are served from
//     MEDIA_ROOT; everything else under /media/ answers 404;
//   * /_protected_media/ is `internal`: a browser asking for it gets 404, but
//     a Django response carrying `X-Accel-Redirect: /_protected_media/<path>`
//     is answered with that file (after Django checked access);
//   * everything else is proxied to Django unchanged.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { createServer } from "./http-util.mjs";

export const PUBLIC_MEDIA_PREFIXES = ["course_thumbnails/", "profile_images/", "guide_videos/", "national_desk/"];

const TYPES = {
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
  ".webm": "video/webm",
};

function resolveInside(root, relative) {
  const decoded = decodeURIComponent(relative.split("?")[0]);
  const target = path.resolve(root, decoded);
  const base = path.resolve(root) + path.sep;
  return target.startsWith(base) ? target : null;
}

function sendFile(res, file, { status = 200, headers = {}, method = "GET" } = {}) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Not Found\n");
    }
    res.writeHead(status, {
      "Content-Type": headers["content-type"] || TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "X-Content-Type-Options": "nosniff",
      ...Object.fromEntries(
        Object.entries(headers).filter(([key]) => !["content-type", "content-length", "x-accel-redirect"].includes(key))
      ),
    });
    if (method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// Django's dev server closes idle keep-alive sockets; a fresh connection per
// request avoids proxying onto a socket it already reset (ECONNRESET -> 502).
const upstreamAgent = new http.Agent({ keepAlive: false, maxSockets: 64 });

export function createGateway({ djangoPort, mediaRoot, log = () => {} }) {
  const stats = { proxied: 0, accel: 0, mediaDenied: 0, mediaServed: 0 };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://gateway");
    const pathname = url.pathname;

    if (pathname.startsWith("/_protected_media/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Not Found\n");
    }
    if (pathname.startsWith("/media/")) {
      const relative = pathname.slice("/media/".length);
      if (!PUBLIC_MEDIA_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
        stats.mediaDenied += 1;
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("404 Not Found\n");
      }
      const file = resolveInside(mediaRoot, relative);
      if (!file) {
        res.writeHead(404);
        return res.end();
      }
      stats.mediaServed += 1;
      return sendFile(res, file, { headers: { "cache-control": "public, max-age=3600" }, method: req.method });
    }

    stats.proxied += 1;
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: djangoPort,
        agent: upstreamAgent,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, "x-forwarded-proto": "http", "x-forwarded-host": req.headers.host || "" },
      },
      (upstreamRes) => {
        const accel = upstreamRes.headers["x-accel-redirect"];
        if (accel && String(accel).startsWith("/_protected_media/")) {
          upstreamRes.resume();
          stats.accel += 1;
          const file = resolveInside(mediaRoot, String(accel).slice("/_protected_media/".length));
          if (!file) {
            res.writeHead(404);
            return res.end();
          }
          const keep = {};
          for (const name of ["content-type", "content-disposition", "vary", "x-frame-options"]) {
            if (upstreamRes.headers[name]) keep[name] = upstreamRes.headers[name];
          }
          keep["cache-control"] = "private, max-age=300";
          return sendFile(res, file, { headers: keep, method: req.method });
        }
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      log(`gateway: upstream error ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("502 Bad Gateway\n");
      } else res.destroy();
    });
    req.pipe(upstream);
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  return { server, stats };
}
