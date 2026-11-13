// Run with: node --test OSINTCTF/tests/server.test.js
// Not shipped: the Docker build context is an allowlist (see .dockerignore).
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, test } = require("node:test");

process.env.LABS_LMS_API_BASE = "https://lms.example.test/api/";
process.env.LABS_PUBLIC_DIR = path.resolve(__dirname, "..");

const { server, resolveLmsApiBase, resolvePublicFile, contentSecurityPolicy } = require("../server.js");

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test("GET /api/config returns the LMS API base without a trailing slash", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { lmsApiBase: "https://lms.example.test/api" });
});

test("the CSP lets the page call the LMS origin and nothing else new", async () => {
  const response = await fetch(`${base}/`);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com https:\/\/lms\.example\.test;/);
  assert.equal(csp, contentSecurityPolicy());
});

test("exam.js is served; private files are not", async () => {
  const exam = await fetch(`${base}/exam.js`);
  assert.equal(exam.status, 200);
  assert.match(exam.headers.get("content-type"), /javascript/);
  for (const blocked of ["/solutions_guide.md", "/private/", "/server.js", "/tests/server.test.js", "/README.md"]) {
    const response = await fetch(`${base}${blocked}`);
    assert.equal(response.status, 404, blocked);
  }
});

test("documents and scripts are never served from /materials/", () => {
  for (const name of ["page.html", "page.HTM", "image.svg", "code.js", "code.mjs", "feed.xml", "doc.xhtml"]) {
    assert.equal(resolvePublicFile(`/materials/exams/x/${name}`), null, name);
  }
  assert.notEqual(resolvePublicFile("/materials/exams/x/photo.jpg"), null);
  assert.equal(resolvePublicFile("/materials/../server.js"), null);
});

test("invalid LMS bases fall back to the production default", () => {
  assert.equal(resolveLmsApiBase(""), "https://alsyedinitiative.com/api");
  assert.equal(resolveLmsApiBase("javascript:alert(1)"), "https://alsyedinitiative.com/api");
  assert.equal(resolveLmsApiBase("https://user:pw@evil.example/api"), "https://alsyedinitiative.com/api");
  assert.equal(resolveLmsApiBase("http://127.0.0.1:8000/api"), "http://127.0.0.1:8000/api");
});
