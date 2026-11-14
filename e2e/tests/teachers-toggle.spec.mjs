// Teachers section switch (UI overhaul plan §5, WS-F): off by default; an
// instructor sees Teach greyed out with a calm reason and the server refuses
// teaching calls with 403 feature_disabled; the admin turns it on in the
// Django back office (Settings › Features) with a note, sees the status line
// and the history; the instructor gets Teach back on window focus; the admin
// turns it off again and the instructor's next API call swaps the open page
// to the off state. The student Console never changes.
import fs from "node:fs";
import path from "node:path";

import { apiAs, expect, isMobile, newUserContext, signIn, signInToBackOffice, test } from "./helpers.mjs";

const REASON = "Teaching tools are switched off for now. An admin can turn them on.";
const SHOTS = process.env.E2E_SHOTS_DIR || "";

async function shot(page, testInfo, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const width = page.viewportSize()?.width || (isMobile(testInfo) ? 390 : 1440);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), animations: "disabled" });
}

/** The Console menu that holds the workspace switch: side nav (desktop) or More sheet (phone). */
async function openMenu(page, testInfo) {
  if (!isMobile(testInfo)) return page.locator("#cds-app-side-nav");
  await page.getByRole("button", { name: "More", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function closeMenu(page, testInfo) {
  if (!isMobile(testInfo)) return;
  const sheet = page.getByRole("dialog", { name: "More" });
  if (await sheet.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
}

function teachSegment(menu) {
  return menu.getByRole("group", { name: "Workspace" }).getByRole("button", { name: /Teach/ });
}

async function expectStudentConsoleUnchanged(page, testInfo) {
  await page.goto("/console");
  await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "learn");
  const menu = await openMenu(page, testInfo);
  await expect(menu.getByRole("group", { name: "Workspace" })).toHaveCount(0);
  await expect(page.getByText("Teaching is switched off")).toHaveCount(0);
  await closeMenu(page, testInfo);
}

/** Flip the Teachers section in the Django Features page through its confirm panel. */
async function flipInBackOffice(admin, { on, note }) {
  const card = admin.locator('[data-ff-card="teaching"]');
  const toggle = card.getByRole("switch", { name: "Teachers section" });
  await expect(toggle).toHaveAttribute("aria-checked", on ? "false" : "true");
  await toggle.focus();
  await admin.keyboard.press("Enter"); // keyboard opens the inline confirm panel (never confirm())
  const panel = card.locator(".ff-confirm");
  await expect(panel.getByRole("heading", { name: `Turn ${on ? "on" : "off"} the Teachers section?` })).toBeVisible();
  if (note) await panel.getByLabel(/Note for the history/).fill(note);
  const saved = admin.waitForResponse((r) => r.url().includes("/admin/core/featureflag/") && r.request().method() === "POST");
  await panel.getByRole("button", { name: on ? "Turn on" : "Turn off" }).click();
  expect((await saved).status()).toBe(200);
  await expect(admin.locator("#ff-status")).toContainText(on ? "Teachers section is on. Instructors will see it within seconds." : "Teachers section is off.");
  await expect(admin.locator('[data-ff-card="teaching"]').getByRole("switch", { name: "Teachers section" })).toHaveAttribute(
    "aria-checked",
    on ? "true" : "false"
  );
}

test("teachers toggle: off by default, admin turns it on and off, the server enforces it", async ({ page, context, control, browser, pageErrors }, testInfo) => {
  const manifest = await control.reset();
  await control.fixture("features", { set: { teaching: false } }); // explicit: production default
  const student = await newUserContext(browser, testInfo, pageErrors, "student");
  const studentPage = await student.newPage();
  await signIn(student, manifest, "student1");
  const backOffice = await newUserContext(browser, testInfo, pageErrors, "admin");
  const admin = await backOffice.newPage();

  await test.step("the student Console has no Teach workspace", async () => {
    await expectStudentConsoleUnchanged(studentPage, testInfo);
  });

  await test.step("instructor: Teach is greyed out with the reason; the server refuses teaching calls", async () => {
    await signIn(context, manifest, "instructor");
    await page.goto("/console");
    const menu = await openMenu(page, testInfo);
    const teach = teachSegment(menu);
    await expect(teach).toHaveAttribute("aria-disabled", "true");
    await teach.click({ force: true }); // focusable and pressable: it explains itself, never navigates
    // The reason is attached to the segment (tooltip / description; its exact rendering is WS-B's).
    await expect(menu.getByText(REASON).first()).toBeAttached();
    await teach.focus();
    await expect(page).toHaveURL(/\/console$/);
    await shot(page, testInfo, "console-teach-disabled");
    await closeMenu(page, testInfo);

    await page.goto("/console/teach");
    await expect(page.getByRole("heading", { name: "Teaching is switched off" })).toBeVisible();
    await expect(page.locator("#main-content").getByText(REASON)).toBeVisible();
    await expect(page.locator("#main-content").getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/console");
    await expect(page).toHaveURL(/\/console\/teach$/); // no bounce to the website
    await shot(page, testInfo, "console-teach-off-page");

    const create = await apiAs(context, "POST", "/api/courses/", { data: { title: "Should not exist" } });
    expect(create.status()).toBe(403);
    const body = await create.json();
    expect(body.code).toBe("feature_disabled");
    expect(body.detail).toBe(REASON);
    expect(body.errors.feature).toBe("teaching");
  });

  await test.step("admin turns the Teachers section on in Settings › Features, with a note", async () => {
    await signInToBackOffice(admin, manifest, "admin", { next: "/admin/settings/features/" });
    await expect(admin).toHaveURL(/\/admin\/core\/featureflag\/$/);
    await expect(admin.getByRole("heading", { name: "Features", level: 1 })).toBeVisible();
    const card = admin.locator('[data-ff-card="teaching"]');
    await expect(card.getByRole("heading", { name: "Teachers section" })).toBeVisible();
    await expect(card.locator("[data-ff-tag]")).toHaveText("Off");
    await expect(card).toContainText("Default · off for new installs");
    await shot(admin, testInfo, "django-features-off");

    // Esc cancels and returns focus to the switch.
    const toggle = card.getByRole("switch", { name: "Teachers section" });
    await toggle.focus();
    await admin.keyboard.press("Enter");
    await expect(card.locator(".ff-confirm")).toBeVisible();
    await card.getByLabel(/Note for the history/).fill("Spring term starts");
    await shot(admin, testInfo, "django-features-confirm");
    await admin.keyboard.press("Escape");
    await expect(card.locator(".ff-confirm")).toBeHidden();
    await expect(toggle).toBeFocused();

    await flipInBackOffice(admin, { on: true, note: "Spring term starts" });
    await expect(admin.locator("#ff-status").getByRole("button", { name: "Undo" })).toBeVisible();
    const fresh = admin.locator('[data-ff-card="teaching"]');
    await expect(fresh.locator("[data-ff-tag]")).toHaveText("On");
    await expect(fresh).toContainText("Turned on by Ayesha Admin");
    await fresh.getByText("History (1)").click();
    await expect(fresh.locator(".ff-history__list")).toContainText("Spring term starts");
    await expect(fresh.locator(".ff-history__list")).toContainText("Off → On");
    await shot(admin, testInfo, "django-features-on");
  });

  await test.step("instructor focuses the window: the open off page turns into Teach without a reload", async () => {
    // Still on /console/teach (the off page) with stale capabilities.
    await expect(page.getByRole("heading", { name: "Teaching is switched off" })).toBeVisible();
    const refreshed = page.waitForResponse((r) => r.url().includes("/api/me/capabilities/"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    expect((await refreshed).ok()).toBeTruthy();
    await expect(page.getByRole("heading", { name: "Teaching is switched off" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/console\/teach$/);
    await shot(page, testInfo, "console-teach-on");
    const menu = await openMenu(page, testInfo);
    await expect(teachSegment(menu)).not.toHaveAttribute("aria-disabled", "true");
    await closeMenu(page, testInfo);
    const list = await apiAs(context, "GET", "/api/instructor/courses/");
    expect(list.status()).toBe(200);
  });

  await test.step("admin turns it off: the instructor's next API call swaps the open page to the off state", async () => {
    await flipInBackOffice(admin, { on: false, note: "Term over" });
    await shot(admin, testInfo, "django-features-turned-off");

    // The instructor is still on the Teach page (stale capabilities); the next
    // teaching call answers feature_disabled and the gate swaps in place.
    const refused = page.waitForResponse((r) => r.url().includes("/api/") && r.status() === 403, { timeout: 15_000 }).catch(() => null);
    if (isMobile(testInfo)) {
      await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /^Grading/ }).click();
    } else {
      await page.locator("#cds-app-side-nav").getByRole("link", { name: /^Grading/ }).first().click();
    }
    const answer = await refused;
    if (!answer) {
      // The page made no teaching call (placeholder page): focus re-checks instead.
      testInfo.annotations.push({ type: "note", description: "no teaching API call on the Grading page; used window focus" });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    } else {
      expect((await answer.json()).code).toBe("feature_disabled");
    }
    await expect(page.getByRole("heading", { name: "Teaching is switched off" })).toBeVisible();
    if (answer) {
      await expect(page.getByText("Teaching was switched off by an admin. Unsaved changes are kept on this device.")).toBeVisible();
    }
    await expect(page).toHaveURL(/\/console\/teach/);
    await shot(page, testInfo, "console-teach-switched-off-live");
  });

  await test.step("the student Console is still unchanged", async () => {
    await expectStudentConsoleUnchanged(studentPage, testInfo);
  });

  await student.close();
  await backOffice.close();
});
