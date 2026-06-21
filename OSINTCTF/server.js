const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.resolve(process.env.LABS_PUBLIC_DIR || path.join(__dirname, "public"));
const BODY_LIMIT_BYTES = 8192;
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 30;

const answerHashes = [
  ["cfd866c1ff6e423edcbc73068b851f9ff15c67ee7beb0c58feb1c18f5f494227"],
  ["b61f5486f1122f720f716dcde4d897b2398589959fa201c1ebc3db9ffaa1bc2c"],
  ["c6c97a1c6bbd94716e8b88009b993f3378e3dcc2f1ba8c7f5a27ef2b511bea08"],
  ["712a09765bf36dd0d79ac5df4facdd03a3ba4a5fb516c4d48f15b582e349a308"],
  ["c58f6e8f6ef404022190de54e87fa127127658723eec77a13b150061c39dc880"],
  ["9671259b8cc1b8d099afbc0b8a0ed6f63fd64042ed2a491134847f71b05ccf4a"],
  ["9711baffdff1925b11ecc08cc656e5aeda9c7e087503eae9ee7fb60a59504da4"],
  ["94f8607915dff25f013e45fc0642fb9830b0fb25ab0ab46d477eaf1061def379"],
  [
    "54af75bffe1ddf9596a9e7dcab901e692f7663bb695af7deaeab8daeb329c5f2",
    "fb6f19743f9bcd979f1f2f1aa47a8414a85ff120f99bc080692130736a87c73b",
  ],
  ["530446297de84ffc9f2925fe906faeabfbc22d9d6d883d69c1689cf643275d1f"],
];

const contentTypes = {
  ".asc": "application/pgp-keys",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".db": "application/octet-stream",
  ".enc": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const attempts = new Map();
const rootPublicFiles = new Set(["/index.html", "/app.js", "/styles.css"]);

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader(
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function normalizeAnswer(question, answer) {
  let normalized = String(answer || "").normalize("NFC").trim().toLowerCase();
  if (question === 3 || question === 8) {
    normalized = normalized.replace(/\s+/g, "");
  }
  return normalized;
}

function hashAnswer(answer) {
  return crypto.createHash("sha256").update(answer, "utf8").digest("hex");
}

function secureHashMatch(actual, expected) {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function clientAddress(req) {
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return String(Array.isArray(realIp) ? realIp[0] : realIp).trim();
  }

  const forwarded = req.headers["x-forwarded-for"];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function consumeAttempt(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const current = attempts.get(key);

  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }

  current.count += 1;
  if (current.count > ATTEMPT_LIMIT) return false;
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > BODY_LIMIT_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

async function validateAnswer(req, res) {
  if (!consumeAttempt(req)) {
    res.setHeader("Retry-After", "60");
    sendJson(res, 429, { error: "Too many attempts. Try again in one minute." });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const question = Number(payload.question);
  const answer = payload.answer;
  if (
    payload.category !== "realworld"
    || !Number.isInteger(question)
    || question < 0
    || question >= answerHashes.length
    || typeof answer !== "string"
    || answer.length > 512
  ) {
    sendJson(res, 400, { error: "Invalid validation request." });
    return;
  }

  const submittedHash = hashAnswer(normalizeAnswer(question, answer));
  const correct = answerHashes[question].some((expected) => secureHashMatch(submittedHash, expected));
  sendJson(res, 200, { correct });
}

function resolvePublicFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  const requestPath = decoded === "/" ? "/index.html" : decoded;
  const isRootImage = /^\/[^/]+\.png$/i.test(requestPath);
  const isStudentMaterial = requestPath.startsWith("/materials/");
  if (!rootPublicFiles.has(requestPath) && !isRootImage && !isStudentMaterial) {
    return null;
  }

  const absolutePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (absolutePath !== PUBLIC_DIR && !absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return null;
  }
  return absolutePath;
}

function serveStatic(req, res, pathname) {
  const file = resolvePublicFile(pathname);
  if (!file) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    securityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Cache-Control", pathname === "/" || pathname.endsWith(".html") || pathname.endsWith(".js")
      ? "no-cache"
      : "public, max-age=3600");
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/healthz" && req.method === "GET") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/api/validate" && req.method === "POST") {
    await validateAnswer(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`AL SYED OSINT labs listening on ${PORT}`);
});
