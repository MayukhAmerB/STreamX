// Members-only labs (LMS feature switch "labs_membership_required").
//
// Off (the default): the labs are exactly as open as before; nothing here
// changes a response. On: every lab page, answer check and lab material needs a
// valid *labs pass*: a short-lived HMAC-SHA256 token the LMS issues to a
// signed-in member (POST <LMS>/ctf/labs/pass/), stored here in an HttpOnly
// cookie (POST /api/session) and verified locally with LABS_PASS_SECRET.
//   - CTF Labs members (and staff): easy, medium, expert, professional.
//   - Starter members: easy and medium only.
// The policy (is the switch on?) is read from the LMS (GET <LMS>/labs/policy/)
// at most every POLICY_TTL_MS; if the LMS cannot be reached the last known
// answer is kept, and before any answer the labs stay open (no lock-out at
// deploy).
"use strict";

const crypto = require("crypto");

const PASS_COOKIE = "labs_pass";
const PASS_VERSION = "v1";
const POLICY_TTL_MS = 30_000;
const DIFFICULTIES = ["easy", "medium", "expert", "professional"];

// Difficulty of every lab question (index = question number) and material folder.
const QUESTION_DIFFICULTY = {
  realworld: ["easy", "easy", "easy", "medium", "medium", "medium", "expert", "expert", "expert", "expert"],
  blackmeridian: Array(10).fill("expert"),
  certification: Array(10).fill("professional"),
};
const MATERIAL_DIFFICULTY = {
  easy: "easy",
  medium: "medium",
  hard: "expert",
  "black-meridian": "expert",
  certification: "professional",
};

function b64urlDecode(text) {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (String(text).length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function b64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Verify a pass; returns its payload or null. Mirrors apps/osint_labs/access.py verify_pass. */
function verifyPass(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PASS_VERSION) return null;
  const expected = b64url(crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`, "ascii").digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !(Number(payload.exp) > nowSeconds)) return null;
  const dif = Array.isArray(payload.dif) ? payload.dif.filter((item) => DIFFICULTIES.includes(item)) : [];
  return { sub: Number(payload.sub) || 0, dif, staff: payload.stf === true, exam: payload.exm === true, exp: Number(payload.exp) };
}

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function createAccess({ lmsApiBase, secret = process.env.LABS_PASS_SECRET || "", fetchImpl = globalThis.fetch, policyUrl } = {}) {
  const state = {
    required: null, // null = unknown (open until the LMS answers)
    checkedAt: 0,
    inflight: null,
  };
  const url = policyUrl || process.env.LABS_POLICY_URL || `${lmsApiBase}/labs/policy/`;

  async function refreshPolicy() {
    if (typeof fetchImpl !== "function") return;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) return;
      const body = await response.json();
      const data = body && typeof body === "object" && body.data ? body.data : body;
      if (data && typeof data.membership_required === "boolean") state.required = data.membership_required;
    } catch {
      // keep the last known answer
    } finally {
      state.checkedAt = Date.now();
    }
  }

  async function membershipRequired() {
    if (Date.now() - state.checkedAt > POLICY_TTL_MS) {
      if (!state.inflight) state.inflight = refreshPolicy().finally(() => { state.inflight = null; });
      // The first answer is awaited; later refreshes run in the background.
      if (state.required === null) await state.inflight;
    }
    return state.required === true;
  }

  function passFor(req) {
    return verifyPass(readCookie(req, PASS_COOKIE), secret);
  }

  /** {required, allowed:[...difficulties], member:bool} for this request. */
  async function accessFor(req) {
    const required = await membershipRequired();
    if (!required) return { required: false, allowed: DIFFICULTIES.slice(), member: true, pages: true };
    const pass = passFor(req);
    const allowed = pass ? (pass.staff ? DIFFICULTIES.slice() : pass.dif) : [];
    // Pages open for members, and for enrolled students (Examination tab only:
    // lab answers and materials still need the difficulty).
    return { required: true, allowed, member: allowed.length > 0, pages: allowed.length > 0 || Boolean(pass && pass.exam) };
  }

  function questionDifficulty(category, question) {
    const list = QUESTION_DIFFICULTY[category];
    return list ? list[question] || "professional" : "professional";
  }

  function materialDifficulty(pathname) {
    const match = /^\/materials\/([^/]+)\//.exec(pathname);
    return match ? MATERIAL_DIFFICULTY[match[1]] || "professional" : "professional";
  }

  function sessionCookie(token, maxAgeSeconds, secure) {
    const attrs = [`${PASS_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
  }

  return {
    accessFor,
    membershipRequired,
    passFor,
    questionDifficulty,
    materialDifficulty,
    sessionCookie,
    verify: (token) => verifyPass(token, secret),
    _state: state,
  };
}

function gatePage({ lmsApiBase, siteUrl }) {
  const lms = JSON.stringify(lmsApiBase);
  const site = JSON.stringify(siteUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OSINT Labs · Members</title><link rel="stylesheet" href="/styles.css">
<style>
:root{--bg:#000;--fg:#fff;--muted:#a3a3a3;--line:rgba(255,255,255,.14);--gold:#F3E2B3}
html,body{margin:0;background:var(--bg);color:var(--fg);font-family:Geist,ui-sans-serif,system-ui,sans-serif}
main{min-height:100vh;display:grid;place-items:center;padding:24px 20px;box-sizing:border-box}
.gate{max-width:560px;text-align:center}
.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h1{font-size:clamp(36px,7vw,60px);line-height:1.05;font-weight:600;margin:16px 0}
h1 em{font-family:Handlee,cursive;font-style:normal;color:var(--gold);font-weight:400}
p{color:var(--muted);line-height:1.6;margin:0 0 28px}
.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
a.btn{display:inline-flex;align-items:center;height:44px;padding:0 20px;border-radius:8px;text-decoration:none;font-weight:500;border:1px solid var(--line);color:var(--fg)}
a.btn.primary{background:var(--fg);color:#000;border-color:var(--fg)}
a.btn:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
</style></head>
<body><main><section class="gate" aria-live="polite">
<div class="eyebrow">Al Syed OSINT Labs</div>
<h1>For <em>members</em>.</h1>
<p id="gate-text">Checking your membership…</p>
<div class="actions" id="gate-actions" hidden>
<a class="btn primary" id="gate-signin" href="#">Sign in</a>
<a class="btn" id="gate-pricing" href="#">See membership plans</a>
</div></section></main>
<script>
(function(){
  var lms=${lms}, site=${site};
  var text=document.getElementById("gate-text"), actions=document.getElementById("gate-actions");
  document.getElementById("gate-signin").href=site+"/login?next="+encodeURIComponent(location.href);
  document.getElementById("gate-pricing").href=site+"/pricing";
  function show(message){text.textContent=message;actions.hidden=false;}
  fetch(lms+"/auth/csrf/",{credentials:"include",cache:"no-store"}).then(function(r){return r.json();}).then(function(c){
    return fetch(lms+"/ctf/labs/pass/",{method:"POST",credentials:"include",cache:"no-store",
      headers:{"Content-Type":"application/json","Accept":"application/json","X-CSRFToken":String((c&&c.csrf_token)||"")},body:"{}"});
  }).then(function(r){
    if(r.status===401||r.status===403){show("Sign in with your Al Syed account to open the labs.");return null;}
    return r.json();
  }).then(function(body){
    if(!body)return;
    var data=body.data||{};
    if(!data.token||!((data.allowed_difficulties||[]).length||data.exam_access)){show("The labs are open to CTF Labs and Starter members.");return;}
    return fetch("/api/session",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:data.token})}).then(function(r){if(r.ok){location.reload();}else{show("We could not open the labs. Try again.");}});
  }).catch(function(){show("We could not reach your account. Sign in and try again.");});
})();
</script></body></html>`;
}

module.exports = { createAccess, gatePage, verifyPass, readCookie, DIFFICULTIES, QUESTION_DIFFICULTY, MATERIAL_DIFFICULTY, PASS_COOKIE };
