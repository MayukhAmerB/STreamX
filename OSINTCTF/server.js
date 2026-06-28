const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.resolve(process.env.LABS_PUBLIC_DIR || __dirname);
const BODY_LIMIT_BYTES = 8192;
const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_LIMIT = 30;
const CERTIFICATION_ANSWER_SECRET = process.env.CERTIFICATION_ANSWER_SECRET || "";

const answerHashes = {
  realworld: [
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
  ],
  blackmeridian: [
    ["c9efd229a65d6e13a32a4a2468724664a224d6110a7f99a21b53bbebfc89d5db"],
    ["39bfb1653f3c411e02945bb5b82e643c1ef764e05fb579c77094931c6790b1a2"],
    ["0633e3c5acc125720bebed5eee5dbc7f336e896b44c38bf12ebeefa99c79be07"],
    ["ed7ff0bb5a535957a2646a81b390ddfc0c7bb721fd6240f3be88ed5ab4a97c27"],
    ["59bf84dcc63f9d953fe385bf3054de875b9c2f647ce6c55999c0f6aa4baa4a00"],
    ["c1d032039c48b362c0faa2f0b92defe8504130424157137c0d30d0906f19af17"],
    [
      "6950947322451c9296c71d5cc26b7d08b64f879cf06145494808418f8064e4bb",
      "6a9e30d0fe28d8c5ad7ee1df4b84df35e15a9ad62c5082c500840a9dd35198f4",
      "b890cfc76f639facdf3e795f6ffa35f54a9730da67f0ae3d4fb2d7afee42657a",
      "ac00a5f13a60b39673da6da2cc989a3a2b3c617f76d0d88e316c941697ba8f54",
    ],
    ["d3408a291c3ecbc2b1739c535deab55a565d7cf4bdda8cd074a72c0db8387e58"],
    ["d14fe4352ec9713a5911d5c749b0d522c3d06c14c875a51bb9662f2cd72a77ce"],
    ["c54baa2be0ec47ce33134dc4dbecfae90c257017b9776be01a51957abb118112"],
  ],
  certification: [
    ["4ac0a79338aed9188116432402e90a30071a738fa236c5308a6b1b2e0c238135"],
    ["1679fbf39490b759353a266a8d7b528f8fda66d2e01a3a2ecc76842362758b5f"],
    ["ce2ccc4f806b7431a89170a4da0be98ff8a9ae0c431694ddc7aeeb87f61dd013"],
    ["9e74c1bdb4975e6b8767edda753bdd2fe03f52ac65624ed3637c478cd534d5dd"],
    ["f81908744b25b1e277d56df2d6e39b423438fc3b181e412b99c0e07bfa81c93a"],
    [
      "03d49f04c65fde2d7aad0abb6ee515a814a3dcece2b2053e255944fb6eb38f6d",
      "b3a92bee1d7c3c0848069028cdb74ed7ec7ed3a4936ac8a9d0b6454870bbfdf5",
    ],
    ["ed772139f5cb83693b9f5f67a3b8d8eb75f50b0212b5610c457ab76f6c222d2a"],
    ["1d61dbc36d284927d682103b800500dccc8f9a823932e8070b12215118cf1b8b"],
    ["cacb7e16b3921ba02e900d07b673675c01c3a603e6bf6cc6dcbc39925e3f2986"],
    ["a6e31d7b80318ed4622466a43127039cfa96bdc15644ba04811f5207ca51bea9"],
  ],
};

const contentTypes = {
  ".asc": "application/pgp-keys",
  ".b64": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".db": "application/octet-stream",
  ".enc": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".py": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const attempts = new Map();
const rootPublicFiles = new Set([
  "/index.html",
  "/app.js",
  "/styles.css",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon-48x48.png",
  "/favicon-192x192.png",
  "/apple-touch-icon.png",
]);

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
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; form-action 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function normalizeAnswer(category, question, answer) {
  let normalized = String(answer || "").normalize("NFC").trim();
  if (!(category === "certification" && question === 9)) {
    normalized = normalized.toLowerCase();
  }
  if (question === 3 || question === 8 || (category === "certification" && (question === 2 || question === 7))) {
    normalized = normalized.replace(/\s+/g, "");
  }
  return normalized;
}

function hashAnswer(answer) {
  return crypto.createHash("sha256").update(answer, "utf8").digest("hex");
}

function proofAnswer(category, answer) {
  if (category === "certification") {
    if (!CERTIFICATION_ANSWER_SECRET) return "";
    return crypto.createHmac("sha256", CERTIFICATION_ANSWER_SECRET).update(answer, "utf8").digest("hex");
  }
  return hashAnswer(answer);
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
    !Object.hasOwn(answerHashes, payload.category)
    || !Number.isInteger(question)
    || question < 0
    || question >= answerHashes[payload.category].length
    || typeof answer !== "string"
    || answer.length > 512
  ) {
    sendJson(res, 400, { error: "Invalid validation request." });
    return;
  }

  const submittedHash = proofAnswer(payload.category, normalizeAnswer(payload.category, question, answer));
  if (!submittedHash) {
    sendJson(res, 503, { error: "Certification validation is not configured." });
    return;
  }
  const correct = answerHashes[payload.category][question].some((expected) => secureHashMatch(submittedHash, expected));
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
