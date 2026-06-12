const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.resolve(process.env.CASES_PUBLIC_DIR || path.join(ROOT_DIR, "public"));
const CONTENT_DIR = path.resolve(process.env.CASES_CONTENT_DIR || path.join(ROOT_DIR, "content", "cases"));
const CONTENT_SEED_DIR = path.resolve(path.join(ROOT_DIR, "content-seed", "cases"));
const UPLOADS_DIR = path.resolve(path.join(PUBLIC_DIR, "uploads"));
const UPLOADS_SEED_DIR = path.resolve(path.join(ROOT_DIR, "uploads-seed"));
const INDEX_FILE = path.join(PUBLIC_DIR, "cases-index.json");
const PORT = Number(process.env.PORT || 8080);
const CONTROL_USERNAME = process.env.CASE_CONTROL_USERNAME || "admin";
const CONTROL_PASSWORD = process.env.CASE_CONTROL_PASSWORD || "";
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const SESSION_COOKIE_NAME = "case_control_session";
const REQUESTED_SESSION_TTL_SECONDS = Number(process.env.CASE_CONTROL_SESSION_TTL_SECONDS || 12 * 60 * 60);
const SESSION_TTL_SECONDS = Number.isFinite(REQUESTED_SESSION_TTL_SECONDS) && REQUESTED_SESSION_TTL_SECONDS > 0
  ? REQUESTED_SESSION_TTL_SECONDS
  : 12 * 60 * 60;
const COOKIE_SECURE = process.env.CASE_CONTROL_COOKIE_SECURE !== "0";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
}

function redirect(res, location) {
  send(res, 302, "", { location, "cache-control": "no-store" });
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeEquals(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    cookies[key] = value;
  }
  return cookies;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signSessionPayload(payload) {
  return crypto.createHmac("sha256", CONTROL_PASSWORD).update(payload).digest("base64url");
}

function createSessionToken(username) {
  const payload = base64url(JSON.stringify({
    u: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  }));
  return `${payload}.${signSessionPayload(payload)}`;
}

function verifySessionToken(token) {
  if (!CONTROL_PASSWORD || !token || !token.includes(".")) return "";
  const [payload, signature] = token.split(".", 2);
  if (!payload || !signature || !safeEquals(signature, signSessionPayload(payload))) return "";

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const expiresAt = Number(data.exp || 0);
    const username = String(data.u || "");
    if (!expiresAt || expiresAt < Math.floor(Date.now() / 1000)) return "";
    return safeEquals(username, CONTROL_USERNAME) ? username : "";
  } catch {
    return "";
  }
}

function sessionCookieHeader(username) {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${createSessionToken(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

function clearSessionCookieHeader() {
  const secure = COOKIE_SECURE ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function getBasicAuthUser(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return "";

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    decoded = "";
  }

  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  if (!safeEquals(username, CONTROL_USERNAME) || !safeEquals(password, CONTROL_PASSWORD)) {
    return "";
  }

  return username;
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[SESSION_COOKIE_NAME] || "");
}

function getControlUser(req) {
  if (!CONTROL_PASSWORD) return "";
  return getSessionUser(req) || getBasicAuthUser(req);
}

function requireControlAuth(req, res) {
  if (!CONTROL_PASSWORD) {
    sendJson(res, 503, {
      error: "Case Control is disabled until CASE_CONTROL_PASSWORD is configured.",
    });
    return "";
  }

  const username = getControlUser(req);
  if (!username) {
    sendJson(res, 401, { error: "Sign in required." });
    return "";
  }

  return username;
}

async function copyDirIfExists(source, destination) {
  try {
    await fsp.access(source);
  } catch {
    return;
  }
  await fsp.mkdir(destination, { recursive: true });
  await fsp.cp(source, destination, { recursive: true, force: false, errorOnExist: false });
}

async function seedIfEmpty(seedDir, targetDir) {
  await fsp.mkdir(targetDir, { recursive: true });
  const files = await fsp.readdir(targetDir);
  if (files.length > 0) return;
  await copyDirIfExists(seedDir, targetDir);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function assertSafeSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,89}$/.test(slug)) {
    throw new Error("Slug must contain only lowercase letters, numbers, and hyphens.");
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRichText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function asBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return value === true || value === "true" || value === "1" || value === "on";
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readCaseFile(file) {
  const raw = await fsp.readFile(file, "utf8");
  return JSON.parse(raw);
}

function caseFileForSlug(slug) {
  assertSafeSlug(slug);
  const file = path.resolve(path.join(CONTENT_DIR, `${slug}.json`));
  if (!isInside(CONTENT_DIR, file)) throw new Error("Invalid case path.");
  return file;
}

async function listCases({ includeDrafts = false } = {}) {
  await fsp.mkdir(CONTENT_DIR, { recursive: true });
  const files = (await fsp.readdir(CONTENT_DIR)).filter((file) => file.endsWith(".json"));
  const cases = [];

  for (const file of files) {
    try {
      const data = await readCaseFile(path.join(CONTENT_DIR, file));
      if (!includeDrafts && data.published === false) continue;
      cases.push(data);
    } catch (error) {
      console.warn(`Skipping invalid case file ${file}: ${error.message}`);
    }
  }

  cases.sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    return String(b.updated_at || b.created_at || b.date || "").localeCompare(
      String(a.updated_at || a.created_at || a.date || ""),
    );
  });

  return cases;
}

async function rebuildIndex() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  const published = await listCases({ includeDrafts: false });
  const tempFile = `${INDEX_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempFile, `${JSON.stringify(published, null, 2)}\n`, "utf8");
  await fsp.rename(tempFile, INDEX_FILE);
  return published.length;
}

async function persistCoverUpload(input, slug, existingCover) {
  const dataUrl = String(input.cover_data_url || "");
  if (!dataUrl) return String(input.cover || existingCover || "").trim();

  const match = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error("Cover upload must be a PNG, JPG, JPEG, or WEBP data URL.");
  }

  const extension = match[1].toLowerCase().replace("jpeg", "jpg");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (buffer.length > 6 * 1024 * 1024) {
    throw new Error("Cover image must be 6 MB or smaller.");
  }

  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  const fileName = `${slug}-${Date.now()}.${extension}`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  await fsp.writeFile(filePath, buffer);
  return `/uploads/${fileName}`;
}

async function normalizeCasePayload(input, existing = null, forcedSlug = "") {
  const titleEn = String(input.title_en || "").trim();
  if (!titleEn) throw new Error("English title is required.");

  const slug = forcedSlug || slugify(input.slug || titleEn);
  assertSafeSlug(slug);

  const bodyEn = normalizeRichText(input.body_en);
  const bodyUr = normalizeRichText(input.body_ur);
  const plainBody = stripHtml(bodyEn);
  const now = new Date().toISOString();

  return {
    slug,
    title_en: titleEn,
    title_ur: String(input.title_ur || "").trim(),
    category: String(input.category || "Case Study").trim(),
    outcome: String(input.outcome || "in-progress").trim(),
    outcome_detail_en: String(input.outcome_detail_en || "").trim(),
    outcome_detail_ur: String(input.outcome_detail_ur || "").trim(),
    date: String(input.date || new Date().toISOString().slice(0, 10)).trim(),
    author: String(input.author || "AL SYED Team").trim(),
    cover: await persistCoverUpload(input, slug, existing?.cover),
    summary_en: String(input.summary_en || plainBody.slice(0, 220)).trim(),
    summary_ur: String(input.summary_ur || "").trim(),
    body_en: bodyEn,
    body_ur: bodyUr,
    featured: asBoolean(input.featured, existing?.featured || false),
    published: asBoolean(input.published, existing?.published ?? true),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

async function saveCase(data) {
  await fsp.mkdir(CONTENT_DIR, { recursive: true });
  const file = caseFileForSlug(data.slug);
  const tempFile = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(tempFile, file);
}

async function handleControlApi(req, res, pathname) {
  if (pathname === "/api/case-control/session" && req.method === "GET") {
    if (!CONTROL_PASSWORD) {
      sendJson(res, 503, {
        authenticated: false,
        error: "Case Control is disabled until CASE_CONTROL_PASSWORD is configured.",
      });
      return;
    }
    const username = getControlUser(req);
    sendJson(res, 200, { authenticated: Boolean(username), username });
    return;
  }

  if (pathname === "/api/case-control/login" && req.method === "POST") {
    if (!CONTROL_PASSWORD) {
      sendJson(res, 503, {
        authenticated: false,
        error: "Case Control is disabled until CASE_CONTROL_PASSWORD is configured.",
      });
      return;
    }
    const payload = await readJsonBody(req);
    const username = String(payload.username || "");
    const password = String(payload.password || "");
    if (!safeEquals(username, CONTROL_USERNAME) || !safeEquals(password, CONTROL_PASSWORD)) {
      sendJson(res, 401, { authenticated: false, error: "Invalid username or password." });
      return;
    }
    sendJson(
      res,
      200,
      { authenticated: true, username: CONTROL_USERNAME },
      { "set-cookie": sessionCookieHeader(CONTROL_USERNAME) },
    );
    return;
  }

  if (pathname === "/api/case-control/logout" && req.method === "POST") {
    sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookieHeader() });
    return;
  }

  if (!requireControlAuth(req, res)) return;

  if (pathname === "/api/case-control/cases" && req.method === "GET") {
    sendJson(res, 200, { cases: await listCases({ includeDrafts: true }) });
    return;
  }

  if (pathname === "/api/case-control/cases" && req.method === "POST") {
    const payload = await readJsonBody(req);
    const data = await normalizeCasePayload(payload);
    const targetFile = caseFileForSlug(data.slug);
    try {
      await fsp.access(targetFile);
      sendJson(res, 409, { error: "A case with this slug already exists." });
      return;
    } catch {
      await saveCase(data);
      const publishedCount = await rebuildIndex();
      sendJson(res, 201, { case: data, published_count: publishedCount });
      return;
    }
  }

  const match = pathname.match(/^\/api\/case-control\/cases\/([a-z0-9-]+)$/);
  if (match && req.method === "PUT") {
    const slug = match[1];
    const file = caseFileForSlug(slug);
    const existing = await readCaseFile(file);
    const payload = await readJsonBody(req);
    const data = await normalizeCasePayload(payload, existing, slug);
    await saveCase(data);
    const publishedCount = await rebuildIndex();
    sendJson(res, 200, { case: data, published_count: publishedCount });
    return;
  }

  if (match && req.method === "DELETE") {
    const slug = match[1];
    await fsp.unlink(caseFileForSlug(slug));
    const publishedCount = await rebuildIndex();
    sendJson(res, 200, { deleted: slug, published_count: publishedCount });
    return;
  }

  sendJson(res, 404, { error: "Unknown Case Control endpoint." });
}

async function serveCaseControl(req, res) {
  const file = path.join(PUBLIC_DIR, "case-control", "index.html");
  const html = await fsp.readFile(file, "utf8");
  send(res, 200, html, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
}

async function serveStatic(req, res, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    send(res, 400, "Bad request");
    return;
  }

  if (decodedPath === "/" || decodedPath === "") decodedPath = "/index.html";
  if (decodedPath.endsWith("/")) decodedPath += "index.html";

  const file = path.resolve(path.join(PUBLIC_DIR, decodedPath));
  if (!isInside(PUBLIC_DIR, file)) {
    send(res, 403, "Forbidden");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    send(res, 404, "Not found");
    return;
  }

  if (!stat.isFile()) {
    send(res, 404, "Not found");
    return;
  }

  const extension = path.extname(file).toLowerCase();
  const headers = {
    "content-type": MIME_TYPES[extension] || "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (file === INDEX_FILE || decodedPath.startsWith("/case-control")) {
    headers["cache-control"] = "no-store";
  } else if (decodedPath.startsWith("/uploads/")) {
    headers["cache-control"] = "public, max-age=31536000, immutable";
  } else {
    headers["cache-control"] = "public, max-age=300";
  }

  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const rawPathname = url.pathname;
    const pathname = rawPathname === "/" ? "/" : rawPathname.replace(/\/+$/, "");

    if (req.method === "GET" && pathname === "/healthz") {
      send(res, 200, "ok\n", { "content-type": "text/plain; charset=utf-8" });
      return;
    }

    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      redirect(res, "/case-control/");
      return;
    }

    if (rawPathname === "/case-control") {
      redirect(res, "/case-control/");
      return;
    }

    if (rawPathname === "/case-control/" || rawPathname.startsWith("/case-control/")) {
      await serveCaseControl(req, res);
      return;
    }

    if (pathname.startsWith("/api/case-control/")) {
      await handleControlApi(req, res, pathname);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed", { allow: "GET, HEAD" });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const status = /not found/i.test(error.message) ? 404 : 400;
    sendJson(res, status, { error: error.message || "Request failed." });
  }
}

async function boot() {
  await seedIfEmpty(CONTENT_SEED_DIR, CONTENT_DIR);
  await seedIfEmpty(UPLOADS_SEED_DIR, UPLOADS_DIR);
  await rebuildIndex();

  const server = http.createServer((req, res) => {
    handleRequest(req, res);
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`AL SYED cases service listening on ${PORT}`);
    if (!CONTROL_PASSWORD) {
      console.warn("Case Control is disabled: set CASE_CONTROL_PASSWORD.");
    }
  });
}

boot().catch((error) => {
  console.error(error);
  process.exit(1);
});
