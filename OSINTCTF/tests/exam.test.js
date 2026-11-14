// Run with: node --test OSINTCTF/tests/
// Behaviour of the Examination tab: the pure rules in exam-core.js, and
// exam.js itself driven against a minimal fake DOM and a mocked LMS API
// (eligibility lock, Start reasons, signed evidence URLs, sign-in and terms).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const Core = require("../exam-core.js");

const LMS = "https://lms.example.test";
const LABS = { origin: "https://labs.example.test", pathname: "/" };
const EXAM_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "exam.js"), "utf8");
const CORE_SOURCE = fs.readFileSync(path.resolve(__dirname, "..", "exam-core.js"), "utf8");

// ---------------------------------------------------------------------------
// exam-core.js
// ---------------------------------------------------------------------------
test("evidence URLs: labs paths and signed LMS URLs only", () => {
  const signed = `${LMS}/api/ctf/materials/eyJtIjoxLCJ1IjoyfQ:1xRxBr:75IVTlpOb4kuqUrx/`;
  assert.equal(Core.materialUrlAllowed("/materials/exams/week-5-abc/photo.jpg", LMS), true);
  assert.equal(Core.materialUrlAllowed(signed, LMS), true);
  for (const bad of [
    "/materials/../server.js",
    "/private/answer-key.md",
    "https://evil.example/api/ctf/materials/abc/",
    `${LMS}/api/ctf/materials/abc/?x=1`,
    `${LMS}/api/auth/user/`,
    `http://lms.example.test/api/ctf/materials/abc/`,
    "javascript:alert(1)",
    '/materials/x.jpg" onerror="alert(1)',
    "",
  ]) {
    assert.equal(Core.materialUrlAllowed(bad, LMS), false, bad);
  }
});

test("sign-in and terms links return to the Examination tab", () => {
  const expected = `${LMS}/login?next=${encodeURIComponent("https://labs.example.test/#exam")}`;
  assert.equal(Core.signInUrl(LABS, LMS), expected);
  assert.equal(Core.termsUrl(LABS, LMS), expected);
});

test("eligibility: locked reasons keep one action, ok unlocks", () => {
  assert.deepEqual(Core.eligibilityView(null), { locked: false, reason: "ok", action: null, nextExam: null });
  const blocked = Core.eligibilityView({
    enabled: false,
    reason: "access_expired",
    message: "Your course access has ended.",
    action: { label: "Renew access", url: `${LMS}/my-courses` },
  });
  assert.equal(blocked.locked, true);
  assert.equal(blocked.reason, "access_expired");
  assert.deepEqual(blocked.action, { label: "Renew access", url: `${LMS}/my-courses` });
  const unsafe = Core.eligibilityView({ enabled: false, reason: "no_batch", action: { label: "x", url: "javascript:alert(1)" } });
  assert.equal(unsafe.action, null);
  assert.equal(Core.eligibilityView({ enabled: false, reason: "weird" }).reason, "not_assigned");
  assert.equal(Core.eligibilityView({ enabled: true, reason: "ok", action: { label: "x", url: LMS } }).action, null);
});

test("Start follows the server's start_reason", () => {
  assert.deepEqual(Core.startView({ can_start: true, start_reason: "ok" }), { enabled: true, reason: "ok" });
  assert.deepEqual(Core.startView({ can_start: false, start_reason: "not_configured" }), { enabled: false, reason: "not_configured" });
  // Older LMS without start_reason.
  assert.deepEqual(Core.startView({ can_start: false }), { enabled: false, reason: "not_open" });
  assert.equal(Core.startView(null).enabled, false);
});

test("API failures are classified for the banner", () => {
  assert.equal(Core.classifyFailure(0, "", ""), "network");
  assert.equal(Core.classifyFailure(401, "not_authenticated", ""), "signed_out");
  assert.equal(Core.classifyFailure(403, "", "CSRF Failed: CSRF token missing."), "csrf");
  assert.equal(Core.classifyFailure(403, "terms_acceptance_required", ""), "terms");
  assert.equal(Core.classifyFailure(409, "ctf_exam_closed", ""), "ctf_exam_closed");
});

// ---------------------------------------------------------------------------
// exam.js against a fake DOM
// ---------------------------------------------------------------------------
class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = "";
    this.textContent = "";
    this.hidden = false;
    this.title = "";
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    };
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "title") this.title = "";
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners[type] || []) listener({ target: this, preventDefault() {}, ...event });
  }

  click() {
    this.dispatch("click");
  }

  querySelectorAll() {
    return [];
  }

  querySelector() {
    return null;
  }
}

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function exam(overrides = {}) {
  return {
    slug: "week-5",
    title: { en: "Week 5 OSINT exam", ur: "" },
    status: "published",
    window: "open",
    opens_at: "2026-11-14T05:00:00Z",
    closes_at: "2026-11-14T09:00:00Z",
    time_limit_minutes: 60,
    question_count: 2,
    total_points: 100,
    can_start: true,
    start_reason: "ok",
    participation: null,
    ...overrides,
  };
}

/** Boot exam.js with the given API routes: { "GET /ctf/exams/": response }. */
async function boot(routes, { withCore = true } = {}) {
  const ids = [
    "tab-exam", "nav-exam-btn", "exam-banner", "exam-list", "exam-view", "exam-stats",
    "exam-score", "exam-solved", "exam-timer", "nav-exam-text", "exam-subheading-text",
    "exam-heading-text", "exam-intro-text", "exam-stat-score-label", "exam-stat-solved-label", "exam-stat-time-label",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)]));
  const calls = [];
  const fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ url, method, options });
    if (url === "/api/config") return json(200, { lmsApiBase: `${LMS}/api` });
    const key = `${method} ${url.replace(`${LMS}/api`, "")}`;
    const handler = routes[key];
    if (!handler) return json(404, { errors: { code: "not_found" } });
    return typeof handler === "function" ? handler(options) : handler;
  };
  const body = new FakeElement("body");
  const context = {
    console,
    URL,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    fetch,
    CSS: { escape: (value) => String(value) },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    location: { origin: LABS.origin, pathname: "/", hash: "#exam" },
    history: { replaceState() {} },
    confirm: () => true,
    document: {
      readyState: "complete",
      body,
      visibilityState: "visible",
      getElementById: (id) => elements[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    addEventListener() {},
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  if (withCore) vm.runInContext(CORE_SOURCE, context, { filename: "exam-core.js" });
  vm.runInContext(EXAM_SOURCE, context, { filename: "exam.js" });
  await settle();
  return { elements, calls, context };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function clickAction(elements, action, data = {}) {
  const target = { dataset: { action, ...data } };
  elements["tab-exam"].dispatch("click", { target: { closest: () => target } });
}

test("a student with no batch sees the reason, one action, and a locked tab", async () => {
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, {
      data: {
        enabled: false,
        reason: "no_batch",
        message: "You are not in a batch yet.",
        action: { label: "Browse courses", url: `${LMS}/courses` },
        exam: null,
        next_exam: null,
      },
    }),
    "GET /ctf/exams/": json(200, { data: { results: [] } }),
  });
  const list = elements["exam-list"].innerHTML;
  assert.match(list, /data-reason="no_batch"/);
  assert.match(list, /You are not in a batch yet\. Enrol in a course/);
  assert.match(list, /href="https:\/\/lms\.example\.test\/courses"/);
  assert.doesNotMatch(list, /data-action="open"/);
  assert.equal(elements["nav-exam-btn"].attributes["aria-disabled"], "true");
  assert.equal(elements["nav-exam-btn"].classList.contains("exam-nav-locked"), true);
});

test("not assigned yet: shows when the next scheduled exam opens", async () => {
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, {
      data: {
        enabled: false,
        reason: "not_assigned",
        message: "",
        action: null,
        exam: null,
        next_exam: { slug: "w6", title: { en: "Week 6 exam" }, window: "not_open", opens_at: "2026-11-20T04:00:00Z" },
      },
    }),
    "GET /ctf/exams/": json(200, { data: { results: [] } }),
  });
  assert.match(elements["exam-list"].innerHTML, /Your next examination, Week 6 exam, opens/);
});

test("eligible: the list unlocks and Start reflects start_reason", async () => {
  const detail = (overrides) =>
    json(200, {
      data: {
        exam: { ...exam(overrides), briefing: { en: [], ur: [] }, rules: { en: [], ur: [] } },
        participation: null,
        server_time: "2026-11-14T06:00:00Z",
        questions: [],
      },
    });
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, { data: { enabled: true, reason: "ok", message: "", action: null, exam: null, next_exam: null } }),
    "GET /ctf/exams/": json(200, { data: { results: [exam(), exam({ slug: "late", can_start: false, start_reason: "not_configured" })] } }),
    "GET /ctf/exams/week-5/": detail({}),
    "GET /ctf/exams/late/": detail({ slug: "late", can_start: false, start_reason: "not_configured" }),
  });
  assert.match(elements["exam-list"].innerHTML, /data-slug="week-5"/);
  assert.equal(elements["nav-exam-btn"].attributes["aria-disabled"], undefined);

  clickAction(elements, "open", { slug: "week-5" });
  await settle();
  assert.match(elements["exam-view"].innerHTML, /data-action="start"/);

  clickAction(elements, "open", { slug: "late" });
  await settle();
  assert.doesNotMatch(elements["exam-view"].innerHTML, /data-action="start"/);
  assert.match(elements["exam-view"].innerHTML, /Answer checking is not available right now/);
});

test("evidence: signed LMS URLs and labs paths render, anything else is dropped", async () => {
  const signed = `${LMS}/api/ctf/materials/eyJtIjoxfQ:1xRxBr:sig/`;
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, { data: { enabled: true, reason: "ok", message: "", action: null, exam: null, next_exam: null } }),
    "GET /ctf/exams/": json(200, { data: { results: [exam({ can_start: false, start_reason: "started" })] } }),
    "GET /ctf/exams/week-5/": json(200, {
      data: {
        exam: { ...exam({ can_start: false, start_reason: "started" }), briefing: { en: [], ur: [] }, rules: { en: [], ur: [] } },
        participation: { status: "active", started_at: "2026-11-14T05:10:00Z", deadline_at: "2099-01-01T00:00:00Z", submitted_at: null, score: 0, solved_count: 0, wrong_count: 0 },
        server_time: "2026-11-14T06:00:00Z",
        questions: [
          {
            key: "q1", order: 1, category: "geoint", difficulty: "hard", points: 50,
            title: { en: "Harbour" }, prompt: { en: { task: "Find it" } },
            materials: [
              { id: 1, label: { en: "Signed" }, url: signed, kind: "image", alt: { en: "" } },
              { id: null, label: { en: "Legacy" }, url: "/materials/exams/week-5-abc/old.jpg", kind: "image", alt: { en: "" } },
              { id: null, label: { en: "Evil" }, url: "https://evil.example/x.jpg", kind: "image", alt: { en: "" } },
            ],
            max_attempts: 3, attempts_used: 0, solved: false, points_awarded: 0,
          },
        ],
      },
    }),
  });
  clickAction(elements, "open", { slug: "week-5" });
  await settle();
  const view = elements["exam-view"].innerHTML;
  assert.ok(view.includes(`src="${signed}"`), "signed evidence shown");
  assert.ok(view.includes('src="/materials/exams/week-5-abc/old.jpg"'), "labs evidence shown");
  assert.ok(!view.includes("evil.example"), "foreign URL dropped");
});

test("terms not accepted: the banner sends the student to the LMS login, which returns here", async () => {
  const terms = json(403, { errors: { code: "terms_acceptance_required", detail: "You must accept the current Terms and Conditions before continuing." } });
  const { elements } = await boot({ "GET /ctf/eligibility/": terms, "GET /ctf/exams/": terms });
  const banner = elements["exam-banner"].innerHTML;
  const expected = `${LMS}/login?next=${encodeURIComponent("https://labs.example.test/#exam")}`;
  assert.ok(banner.includes(`href="${expected}"`), banner);
  assert.ok(!banner.includes('target="_blank"'), "same tab, so the return lands here");
});

test("signed out: one refresh attempt, then a sign-in link back to the tab", async () => {
  const signedOut = json(401, { errors: { code: "not_authenticated" } });
  const { elements, calls } = await boot({
    "GET /auth/csrf/": json(200, { csrf_token: "token" }),
    "POST /auth/refresh/": json(401, {}),
    "GET /ctf/eligibility/": signedOut,
    "GET /ctf/exams/": signedOut,
  });
  assert.ok(calls.some((call) => call.method === "POST" && call.url.endsWith("/auth/refresh/")));
  const banner = elements["exam-banner"].innerHTML;
  assert.ok(banner.includes(`${LMS}/login?next=`), banner);
  assert.ok(calls.every((call) => call.url === "/api/config" || call.options.credentials === "include"));
});

test("an older LMS without the eligibility endpoint still lists exams", async () => {
  const { elements } = await boot({ "GET /ctf/exams/": json(200, { data: { results: [exam()] } }) });
  assert.match(elements["exam-list"].innerHTML, /data-slug="week-5"/);
});

test("exam.js still works when exam-core.js is not loaded (cached page)", async () => {
  const { elements } = await boot(
    { "GET /ctf/exams/": json(200, { data: { results: [exam()] } }) },
    { withCore: false }
  );
  assert.match(elements["exam-list"].innerHTML, /data-slug="week-5"/);
});

test("the paper opens with the candidate block: roll number, real name, handle, stats, then the questions", async () => {
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, { data: { enabled: true, reason: "ok", message: "", action: null, exam: null, next_exam: null } }),
    "GET /ctf/exams/": json(200, { data: { results: [exam({ can_start: false, start_reason: "started" })] } }),
    "GET /ctf/exams/week-5/identity/": json(200, {
      data: {
        roll_number: "AL-SYD-00042",
        real_name: "Asha <Rao>",
        handle: "quiet_falcon",
        handle_most_recent: "amber_lynx",
        handle_changed: true,
        stats: { xp: null, rank: null, attendance_percent: 87.5, reports_submitted: 6, reports_graded_average: 78.4, exam_score: null, exams_taken: 0 },
        snapshot: false,
        user_id: 42,
      },
    }),
    "GET /ctf/exams/week-5/": json(200, {
      data: {
        exam: { ...exam({ can_start: false, start_reason: "started" }), briefing: { en: ["Brief"], ur: [] }, rules: { en: [], ur: [] } },
        participation: { status: "active", started_at: "2026-11-14T05:10:00Z", deadline_at: "2099-01-01T00:00:00Z", submitted_at: null, score: 0, solved_count: 0, wrong_count: 0 },
        server_time: "2026-11-14T06:00:00Z",
        questions: [
          { key: "q1", order: 1, category: "geoint", difficulty: "hard", points: 50, title: { en: "Harbour" }, prompt: { en: { task: "Find it" } }, materials: [], max_attempts: 3, attempts_used: 0, solved: false, points_awarded: 0 },
        ],
      },
    }),
  });
  clickAction(elements, "open", { slug: "week-5" });
  await settle();
  const view = elements["exam-view"].innerHTML;
  const order = ["ROLL NUMBER", "AL-SYD-00042", "REAL NAME", "Asha &lt;Rao&gt;", "HANDLE", "@quiet_falcon", "Most recent: @amber_lynx", "ATTENDANCE", "87.5%", "REPORTS", "EXAM SCORE", "Brief", "Harbour"];
  const positions = order.map((text) => view.indexOf(text));
  assert.ok(positions.every((value) => value >= 0), `all present: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.ok(!view.includes(">XP<"), "XP hidden while engagement is off");
  assert.ok(!/<input[^>]*exam-identity/.test(view), "read-only");
});

test("an LMS without the identity endpoint still opens the paper", async () => {
  const { elements } = await boot({
    "GET /ctf/eligibility/": json(200, { data: { enabled: true, reason: "ok", message: "", action: null, exam: null, next_exam: null } }),
    "GET /ctf/exams/": json(200, { data: { results: [exam()] } }),
    "GET /ctf/exams/week-5/": json(200, {
      data: { exam: { ...exam(), briefing: { en: [], ur: [] }, rules: { en: [], ur: [] } }, participation: null, server_time: "2026-11-14T06:00:00Z", questions: [] },
    }),
  });
  clickAction(elements, "open", { slug: "week-5" });
  await settle();
  assert.match(elements["exam-view"].innerHTML, /data-action="start"/);
  assert.doesNotMatch(elements["exam-view"].innerHTML, /exam-identity/);
});
