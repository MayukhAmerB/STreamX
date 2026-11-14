// Shared fixtures for the journeys: control API, fresh seed per test, login.
import { test as base, expect, request as playwrightRequest } from "@playwright/test";

export const WEB = process.env.E2E_WEB_URL || "http://localhost:4273";
export const LABS = process.env.E2E_LABS_URL || "http://localhost:8092";
export const OWNCAST = process.env.E2E_OWNCAST_URL || "http://localhost:18081";
export const LIVEKIT = process.env.E2E_LIVEKIT_URL || "http://localhost:18082";
const TOKEN = process.env.E2E_CONTROL_TOKEN || "";

/**
 * A crash caught by a frontend FeatureBoundary no longer blanks the app (so it
 * is not a "pageerror"), but it is still a crash: the boundary logs
 * `[FeatureBoundary] "<panel>" crashed:` and the journey must fail on it.
 */
function watchBoundaries(page, errors, prefix = "") {
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().startsWith("[FeatureBoundary]")) {
      errors.push(`${prefix}${page.url()}: ${message.text().split("\n")[0]}`);
    }
  });
}

/** Control API client (`/api/__e2e__/`), stubs and convenience calls. */
export class Control {
  constructor(api) {
    this.api = api;
  }

  async call(method, path, data) {
    const response = await this.api.fetch(`${WEB}/api/__e2e__/${path}`, {
      method,
      headers: { "X-E2E-Token": TOKEN, "Content-Type": "application/json" },
      data: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    if (!response.ok()) throw new Error(`control ${method} ${path} -> ${response.status()}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }

  async reset(clock) {
    const body = await this.call("POST", "reset/", clock ? { clock } : {});
    await this.owncast({ reset: true });
    await this.livekit({ reset: true });
    return body.manifest;
  }

  clock(spec) {
    return this.call("POST", "clock/", spec);
  }

  /** Run background work now: "jobs", "recorder" or a periodic hook name. */
  tick(steps, extra = {}) {
    return this.call("POST", "tick/", { steps: Array.isArray(steps) ? steps : [steps], ...extra });
  }

  /** Named data tweak or read (backend/apps/e2e_support/views.py FIXTURES). */
  fixture(name, data = {}) {
    return this.call("POST", `fixture/${name}/`, data);
  }

  sessionState(id) {
    return this.call("GET", `sessions/${id}/state/`);
  }

  expireHostHeartbeat(id) {
    return this.call("POST", `sessions/${id}/expire-host-heartbeat/`, {});
  }

  async owncast(state) {
    const response = await this.api.post(`${OWNCAST}/__stub/state`, { data: state });
    return response.json();
  }

  async livekit(state) {
    const response = await this.api.post(`${LIVEKIT}/__stub/state`, { data: state });
    return response.json();
  }
}

/** Calls the LMS API with a browser context's cookies (CSRF header included). */
export async function apiAs(context, method, path, { data, multipart, headers = {} } = {}) {
  const cookies = await context.cookies(WEB);
  let csrf = cookies.find((cookie) => cookie.name === "csrftoken")?.value;
  if (!csrf) {
    await context.request.get(`${WEB}/api/auth/csrf/`);
    csrf = (await context.cookies(WEB)).find((cookie) => cookie.name === "csrftoken")?.value || "";
  }
  return context.request.fetch(`${WEB}${path}`, {
    method,
    headers: { "X-CSRFToken": csrf, Referer: `${WEB}/`, ...headers },
    data,
    multipart,
  });
}

/** Sign in through the API (fast path for journeys that are not about login). */
export async function signIn(context, manifest, who) {
  const user = manifest.users[who];
  await context.request.get(`${WEB}/api/auth/csrf/`);
  const response = await apiAs(context, "POST", "/api/auth/login/", {
    data: { email: user.email, password: manifest.password },
  });
  expect(response.ok(), `login as ${who}: ${await response.text()}`).toBeTruthy();
  return user;
}

/** Sign in through the real login form. */
export async function signInWithForm(page, manifest, who, { path = "/login" } = {}) {
  const user = manifest.users[who];
  await page.goto(path);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(manifest.password);
  await page.getByRole("button", { name: /^Login$/ }).click();
  return user;
}

export const test = base.extend({
  control: async ({}, use) => {
    const api = await playwrightRequest.newContext();
    await use(new Control(api));
    await api.dispose();
  },
  // A freshly seeded database (and real server clock) for every journey.
  manifest: async ({ control }, use) => {
    await use(await control.reset());
  },
  // Every uncaught exception in any page of the journey fails the journey
  // (a React crash blanks the app even when the next assertion would pass).
  pageErrors: [
    async ({ context }, use, testInfo) => {
      const errors = [];
      const watch = (page) => {
        page.on("pageerror", (error) => errors.push(`${page.url()}: ${String(error?.message || error).split("\n")[0]}`));
        watchBoundaries(page, errors);
      };
      context.pages().forEach(watch);
      context.on("page", watch);
      await use(errors);
      if (errors.length) {
        await testInfo.attach("page-errors.txt", { body: errors.join("\n"), contentType: "text/plain" });
      }
      expect.soft(errors, "uncaught page errors (the app crashed)").toEqual([]);
    },
    { auto: true },
  ],
});

/** A second browser (another user or device) with the project's viewport, watched for crashes. */
export async function newUserContext(browser, testInfo, pageErrors, label) {
  const use = testInfo.project.use;
  const context = await browser.newContext({
    baseURL: use.baseURL,
    viewport: use.viewport,
    userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor,
    isMobile: use.isMobile,
    hasTouch: use.hasTouch,
    locale: use.locale,
    timezoneId: use.timezoneId,
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => pageErrors?.push(`${label}: ${page.url()}: ${String(error?.message || error).split("\n")[0]}`));
    if (pageErrors) watchBoundaries(page, pageErrors, `${label}: `);
  });
  return context;
}

export { expect };

export function isMobile(testInfo) {
  return testInfo.project.name === "mobile";
}
