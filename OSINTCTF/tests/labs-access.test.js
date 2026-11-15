// Run with: node --test OSINTCTF/tests/labs-access.test.js
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");

const SECRET = "labs-test-secret-0123456789abcdef";
process.env.LABS_PASS_SECRET = SECRET;
process.env.LABS_PUBLIC_DIR = path.resolve(__dirname, "..");

const { createAccess, verifyPass } = require("../labs-access.js");

const b64url = (buffer) => Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function makePass(payload, secret = SECRET) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`v1.${body}`, "ascii").digest());
  return `v1.${body}.${sig}`;
}

const future = () => Math.floor(Date.now() / 1000) + 600;

test("verifyPass accepts a valid pass and rejects tampering, other secrets and expiry", () => {
  const token = makePass({ sub: 7, dif: ["easy", "medium"], stf: false, exm: true, exp: future() });
  assert.deepEqual(verifyPass(token, SECRET).dif, ["easy", "medium"]);
  assert.equal(verifyPass(token, SECRET).exam, true);
  assert.equal(verifyPass(token, "other"), null);
  assert.equal(verifyPass(token.replace(/.$/, "A"), SECRET), null);
  assert.equal(verifyPass(makePass({ sub: 1, dif: ["easy"], exp: 5 }), SECRET), null);
  assert.equal(verifyPass("", SECRET), null);
  assert.deepEqual(verifyPass(makePass({ sub: 1, dif: ["easy", "root"], exp: future() }), SECRET).dif, ["easy"]);
});

test("policy unknown or off = open labs; LMS failure keeps the last answer", async () => {
  let answer = null;
  const access = createAccess({
    lmsApiBase: "https://lms.example.test/api",
    secret: SECRET,
    fetchImpl: async () => {
      if (answer === "fail") throw new Error("down");
      return { ok: true, json: async () => ({ data: { membership_required: answer === true } }) };
    },
  });
  const req = { headers: {} };
  answer = false;
  assert.equal((await access.accessFor(req)).required, false);
  access._state.checkedAt = 0;
  access._state.required = null;
  answer = true;
  assert.deepEqual(await access.accessFor(req), { required: true, allowed: [], member: false, pages: false });
  access._state.checkedAt = 0;
  answer = "fail";
  await access.membershipRequired();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await access.membershipRequired(), true, "a failed refresh keeps the last known policy");
});

test("difficulty maps for questions and materials", () => {
  const access = createAccess({ lmsApiBase: "https://x.test/api", fetchImpl: null });
  assert.equal(access.questionDifficulty("realworld", 0), "easy");
  assert.equal(access.questionDifficulty("realworld", 4), "medium");
  assert.equal(access.questionDifficulty("realworld", 9), "expert");
  assert.equal(access.questionDifficulty("blackmeridian", 2), "expert");
  assert.equal(access.questionDifficulty("certification", 0), "professional");
  assert.equal(access.materialDifficulty("/materials/easy/view.jpg"), "easy");
  assert.equal(access.materialDifficulty("/materials/hard/x.csv"), "expert");
  assert.equal(access.materialDifficulty("/materials/unknown/x"), "professional");
});

// --- the real server with a members-only policy --------------------------------
let lms;
let base;
let server;

before(async () => {
  lms = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, data: { membership_required: true } }));
  });
  await new Promise((resolve) => lms.listen(0, "127.0.0.1", resolve));
  process.env.LABS_LMS_API_BASE = `http://127.0.0.1:${lms.address().port}/api`;
  delete require.cache[require.resolve("../server.js")];
  ({ server } = require("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => lms.close(resolve));
});

test("members-only: visitors get the gate page, no scripts, materials or answers", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /For <em>members<\/em>/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}/app.js`)).status, 403);
  assert.equal((await fetch(`${base}/materials/easy/view.jpg`)).status, 403);
  assert.equal((await fetch(`${base}/styles.css`)).status, 200);
  const validate = await fetch(`${base}/api/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category: "realworld", question: 0, answer: "x" }),
  });
  assert.equal(validate.status, 403);
});

test("a Starter pass opens easy/medium only; a session cookie is HttpOnly", async () => {
  const token = makePass({ sub: 3, dif: ["easy", "medium"], stf: false, exm: false, exp: future() });
  const session = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie");
  assert.match(cookie, /labs_pass=.*HttpOnly/);
  const headers = { Cookie: cookie.split(";")[0] };
  assert.equal((await fetch(`${base}/`, { headers })).status, 200);
  assert.doesNotMatch(await (await fetch(`${base}/`, { headers })).text(), /For <em>members<\/em>/);
  assert.equal((await fetch(`${base}/materials/easy/view.jpg`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/materials/hard/window_view.jpg`, { headers })).status, 403);
  const expert = await fetch(`${base}/api/validate`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "blackmeridian", question: 0, answer: "x" }),
  });
  assert.equal(expert.status, 403);
  const easy = await fetch(`${base}/api/validate`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ category: "realworld", question: 0, answer: "x" }),
  });
  assert.equal(easy.status, 200);
  const bad = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: makePass({ sub: 3, dif: ["easy"], exp: future() }, "wrong") }),
  });
  assert.equal(bad.status, 400);
});

test("an enrolled student's pass (Batch 2 / Batch 3) opens the Free CTFs only, never the paid labs", async () => {
  const token = makePass({ sub: 11, dif: [], stf: false, exm: true, exp: future() });
  const session = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(session.status, 200);
  assert.deepEqual((await session.json()).allowedDifficulties, ["easy", "medium"]);
  const headers = { Cookie: session.headers.get("set-cookie").split(";")[0] };
  assert.doesNotMatch(await (await fetch(`${base}/`, { headers })).text(), /For <em>members<\/em>/);
  const accessBody = await (await fetch(`${base}/api/access`, { headers })).json();
  assert.deepEqual(accessBody.allowedDifficulties, ["easy", "medium"]);
  assert.equal(accessBody.pass, true);
  const check = (category, question) => fetch(`${base}/api/validate`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ category, question, answer: "x" }),
  });
  assert.equal((await check("realworld", 0)).status, 200);
  assert.equal((await check("realworld", 5)).status, 200);
  assert.equal((await check("realworld", 6)).status, 403);
  assert.equal((await check("blackmeridian", 0)).status, 403);
  assert.equal((await check("certification", 0)).status, 403);
  assert.equal((await fetch(`${base}/materials/medium/leak_email.txt`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/materials/black-meridian/START_HERE.md`, { headers })).status, 403);
});
