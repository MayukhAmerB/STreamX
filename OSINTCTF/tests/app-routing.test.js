// Run with: node --test OSINTCTF/tests/
// Deep links on the labs site (app.js): #hub, #realworld, #blackmeridian and
// #certification select their tab on load, on hashchange (back/forward) and
// from in-page links; clicking a tab updates the address with replaceState
// (no new history entries); #exam is left to exam.js. Plus static checks on
// index.html: no third-party fonts, the access chips, the tab ids.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const INDEX = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const TABS = ["hub", "realworld", "blackmeridian", "certification", "exam"];

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((name) => set.add(name)),
    remove: (...names) => names.forEach((name) => set.delete(name)),
    contains: (name) => set.has(name),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
  };
}

function makeElement(attrs = {}) {
  const listeners = {};
  const element = {
    attrs: { ...attrs },
    classList: makeClassList(),
    style: {},
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    getAttribute: (name) => (name in element.attrs ? element.attrs[name] : null),
    setAttribute: (name, value) => { element.attrs[name] = String(value); },
    removeAttribute: (name) => { delete element.attrs[name]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatch: (type, event = {}) => (listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...event })),
    click: () => element.dispatch("click"),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    appendChild: () => {},
    scrollIntoView: () => {},
  };
  return element;
}

function boot({ hash = "", config = { lmsApiBase: "https://lms.example.test/api" } } = {}) {
  const byId = new Map();
  const navButtons = TABS.map((tab) => {
    const button = makeElement({ "data-tab": tab });
    if (tab === "hub") button.classList.add("active");
    byId.set(`nav-${tab}-btn`, button);
    return button;
  });
  const sections = TABS.map((tab) => {
    const section = makeElement();
    if (tab === "hub") section.classList.add("active");
    byId.set(`tab-${tab}`, section);
    return section;
  });
  const gotoLinks = ["realworld", "exam", "hub"].map((tab) => makeElement({ "data-goto": tab }));
  const chips = [0, 1, 2, 3].map(() => makeElement());
  const docListeners = {};
  const winListeners = {};
  const history = [];
  const location = { hash, pathname: "/" };

  const document = {
    body: makeElement(),
    readyState: "loading",
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeElement());
      return byId.get(id);
    },
    createElement: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: (selector) => ({
      ".nav-btn": navButtons,
      ".tab-content": sections,
      "[data-goto]": gotoLinks,
      "[data-access-chip]": chips,
    })[selector] || [],
  };
  const window = {
    location,
    history: {
      replaceState: (_state, _title, url) => {
        history.push(url);
        location.hash = url.startsWith("#") ? url : "";
      },
    },
    addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); },
    dispatchEvent: () => true,
  };
  const storage = new Map();
  const fetchCalls = [];
  const context = {
    document,
    window,
    console: { warn() {}, log() {}, error() {} },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, json: async () => config };
    },
    Promise,
    setTimeout,
  };
  vm.runInNewContext(APP_SOURCE, context, { filename: "app.js" });
  (docListeners.DOMContentLoaded || []).forEach((fn) => fn());

  const active = () => TABS.filter((_, index) => sections[index].classList.contains("active"));
  const fireHashChange = (next) => {
    location.hash = next;
    (winListeners.hashchange || []).forEach((fn) => fn());
  };
  return { navButtons, sections, gotoLinks, chips, history, location, active, fireHashChange, fetchCalls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("without a hash the hub is shown and the address is left alone", () => {
  const page = boot();
  assert.deepEqual(page.active(), ["hub"]);
  assert.deepEqual(page.history, []);
});

for (const tab of ["realworld", "blackmeridian", "certification"]) {
  test(`#${tab} on load opens that lab`, () => {
    const page = boot({ hash: `#${tab}` });
    assert.deepEqual(page.active(), [tab]);
    const button = page.navButtons[TABS.indexOf(tab)];
    assert.equal(button.getAttribute("aria-current"), "page");
    assert.equal(page.navButtons[0].getAttribute("aria-current"), null);
  });
}

test("#exam on load is left to exam.js (app.js does not switch tabs)", () => {
  const page = boot({ hash: "#exam" });
  assert.deepEqual(page.active(), ["hub"]);
  assert.deepEqual(page.history, []);
});

test("unknown hashes are ignored", () => {
  const page = boot({ hash: "#private" });
  assert.deepEqual(page.active(), ["hub"]);
  page.fireHashChange("#materials");
  assert.deepEqual(page.active(), ["hub"]);
});

test("clicking a tab updates the hash with replaceState; the exam tab does not", () => {
  const page = boot();
  page.navButtons[TABS.indexOf("blackmeridian")].click();
  assert.deepEqual(page.active(), ["blackmeridian"]);
  assert.deepEqual(page.history, ["#blackmeridian"]);
  page.navButtons[TABS.indexOf("exam")].click();
  assert.deepEqual(page.active(), ["exam"]);
  assert.deepEqual(page.history, ["#blackmeridian"]);
});

test("hashchange (typed URL, back and forward) selects the tab", () => {
  const page = boot();
  page.fireHashChange("#certification");
  assert.deepEqual(page.active(), ["certification"]);
  page.fireHashChange("#realworld");
  assert.deepEqual(page.active(), ["realworld"]);
  page.fireHashChange("#exam");
  assert.deepEqual(page.active(), ["exam"]);
});

test("in-page lab links open the tab", () => {
  const page = boot();
  page.gotoLinks[0].click();
  assert.deepEqual(page.active(), ["realworld"]);
  page.gotoLinks[1].click();
  assert.deepEqual(page.active(), ["exam"]);
  page.gotoLinks[2].click();
  assert.deepEqual(page.active(), ["hub"]);
  assert.equal(page.location.hash, "#hub");
});

test("access chips stay 'Open' unless the server reports membershipRequired", async () => {
  const open = boot();
  await flush();
  assert.equal(open.fetchCalls[0].url, "/api/config");
  assert.ok(open.chips.every((chip) => chip.textContent === ""));

  const members = boot({ config: { lmsApiBase: "x", membershipRequired: true } });
  await flush();
  await flush();
  assert.ok(members.chips.every((chip) => chip.textContent === "Members"));
});

test("index.html loads no third-party fonts and preloads the self-hosted ones", () => {
  assert.doesNotMatch(INDEX, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(INDEX, /<link rel="preload" href="\/fonts\/geist\/geist-latin-wght-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
  assert.match(INDEX, /<link rel="preload" href="\/fonts\/handlee\/handlee-latin-400-normal\.woff2" as="font" type="font\/woff2" crossorigin>/);
  for (const font of ["geist/geist-latin-wght-normal.woff2", "geist-mono/geist-mono-latin-wght-normal.woff2", "handlee/handlee-latin-400-normal.woff2"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "fonts", font)), font);
  }
});

test("index.html keeps every tab id app.js and exam.js rely on, with the access chips", () => {
  for (const tab of TABS) {
    assert.match(INDEX, new RegExp(`data-tab="${tab}"`));
    assert.match(INDEX, new RegExp(`id="tab-${tab}"`));
  }
  for (const id of ["nav-hub-btn", "nav-labs-btn", "nav-blackmeridian-btn", "nav-certification-btn", "nav-exam-btn",
    "nav-exam-text", "badge-realworld", "badge-blackmeridian", "badge-certification", "overall-progress-bar",
    "exam-banner", "exam-list", "exam-view", "exam-timer", "lang-toggle"]) {
    assert.match(INDEX, new RegExp(`id="${id}"`), id);
  }
  assert.equal((INDEX.match(/data-access-chip/g) || []).length, 4);
  assert.match(INDEX, /nav-chip-signin[^>]*>[\s\S]*?Sign-in<\/span>/);
});

test("styles.css uses no hue: only greys and the golden-white family", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const offenders = [];
  const check = (r, g, b, raw) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min <= 6) return;
    // golden-white family: warm, r >= g >= b
    if (r >= g && g >= b && r > 200) return;
    offenders.push(raw);
  };
  for (const match of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    let hex = match[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    check(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), match[0]);
  }
  for (const match of css.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) {
    check(Number(match[1]), Number(match[2]), Number(match[3]), match[0]);
  }
  assert.deepEqual(offenders, []);
});

test("styles.css comments never close early (a stray */ drops the next rule)", () => {
  const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  for (const comment of css.match(/\/\*[\s\S]*?\*\//g) || []) {
    const rest = css.slice(css.indexOf(comment) + comment.length).split("\n")[0];
    assert.doesNotMatch(rest, /\*\//, `comment closes early: ${comment.slice(0, 60)}`);
  }
  assert.equal((css.match(/@font-face/g) || []).length, 4);
});

test("index.html: the four sections in order, and Free / Paid labs from the labs config", () => {
  const order = ["nav-hub-btn", "nav-paid-btn", "nav-exam-btn", "nav-leaderboard-btn"].map((id) => INDEX.indexOf(`id="${id}"`));
  assert.ok(order.every((index) => index > 0), "every section button exists");
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, "Free CTFs | Paid Labs | Examination | Leaderboard");
  for (const id of ["tab-paid", "tab-leaderboard", "free-access", "paid-access", "free-directory", "season-board", "hof-board", "user-slot"]) {
    assert.match(INDEX, new RegExp(`id="${id}"`), id);
  }
  assert.match(INDEX, /viewport-fit=cover/);
  // The free tier mirrors labs-access.js: easy and medium are free, the rest is paid.
  const { QUESTION_DIFFICULTY, FREE_DIFFICULTIES } = require("../labs-access.js");
  assert.deepEqual(FREE_DIFFICULTIES, ["easy", "medium"]);
  assert.match(APP_SOURCE, new RegExp(`realworld: ${JSON.stringify(QUESTION_DIFFICULTY.realworld).replace(/,/g, ", ").replace(/[[\]]/g, "\$&")}`));
});

test("app.js and the free directory carry no answers or answer hashes", () => {
  assert.doesNotMatch(APP_SOURCE, /\b[0-9a-f]{64}\b/);
  const directory = JSON.parse(fs.readFileSync(path.join(ROOT, "free-directory.json"), "utf8"));
  assert.ok(directory.items.length > 0);
  for (const item of directory.items) {
    assert.ok(/^https:\/\//.test(item.url), item.slug);
    for (const key of ["flag", "flag_sha256", "answer", "answers"]) assert.equal(item[key], undefined, `${item.slug}.${key}`);
  }
});

test("the paid-labs link and the Batch 2 / Batch 3 wording are in the page logic", () => {
  assert.match(APP_SOURCE, /https:\/\/alsyedinitiative\.com\/courses/);
  assert.match(APP_SOURCE, /Batch 2 and Batch 3/);
  // Free access comes from the LMS eligibility (active course access) and labs entitlement endpoints.
  assert.match(APP_SOURCE, /\/ctf\/eligibility\//);
  assert.match(APP_SOURCE, /\/ctf\/labs\/entitlement\//);
});
