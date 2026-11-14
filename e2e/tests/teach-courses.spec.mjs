// Teach › Courses (UI overhaul WS-D2): an instructor with the Teachers
// section on creates a course, adds a module and two lectures, reorders them
// from the keyboard, and publishes. With the section off (the default) the
// same address shows the in-shell "switched off" page, never a redirect.
import { apiAs, expect, signIn, test } from "./helpers.mjs";

const TITLE = "E2E Recon Basics";

test("teach courses: create, add curriculum, reorder by keyboard, publish", async ({ page, context, control }) => {
  const manifest = await control.reset();
  await control.fixture("features", { set: { teaching: true } });
  await signIn(context, manifest, "instructor");

  await test.step("the course list leads with one action: New course", async () => {
    await page.goto("/console/teach/courses");
    await expect(page.getByRole("heading", { level: 1, name: "Courses" })).toBeVisible();
    await page.getByRole("link", { name: "New course" }).first().click();
    await expect(page).toHaveURL(/\/console\/teach\/courses\/new$/);
    await expect(page.getByRole("heading", { level: 1, name: "New course" })).toBeVisible();
  });

  let courseId;
  await test.step("create: inline validation, then the editor opens on Curriculum", async () => {
    await page.getByRole("button", { name: "Create course" }).click();
    await expect(page.getByText("Give the course a title.")).toBeVisible();
    await page.getByLabel("Title", { exact: true }).fill(TITLE);
    await page.getByLabel("Description", { exact: true }).fill("Find people and places from open sources, step by step.");
    await page.getByLabel("Price (₹)").fill("1999");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/courses/") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create course" }).click();
    expect((await created).status()).toBe(201);
    await expect(page).toHaveURL(/\/console\/teach\/courses\/\d+\?tab=curriculum$/);
    courseId = Number(page.url().match(/courses\/(\d+)/)[1]);
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();
    // Publish explains why it is not available yet.
    await expect(page.getByText("Add at least one lecture before publishing.").first()).toBeAttached();
  });

  await test.step("add a module and two lectures", async () => {
    await page.getByLabel("Module title").fill("Week 1: Search basics");
    await page.getByRole("button", { name: "Add module" }).click();
    await expect(page.getByRole("heading", { level: 3, name: /Week 1: Search basics/ })).toBeVisible();
    for (const [title, key] of [
      ["Search operators", "lectures/e2e/operators.mp4"],
      ["Reverse image search", "lectures/e2e/reverse-image.mp4"],
    ]) {
      await page.getByRole("button", { name: "Add lecture" }).click();
      await page.getByLabel("Lecture title").fill(title);
      await page.getByLabel("Or a storage key or video link").fill(key);
      const added = page.waitForResponse((r) => r.url().endsWith("/api/lectures/") && r.request().method() === "POST");
      await page.getByRole("form", { name: "New lecture" }).getByRole("button", { name: "Add lecture" }).click();
      expect((await added).status()).toBe(201);
      await expect(page.locator(".tch-lecture", { hasText: title })).toBeVisible();
    }
  });

  await test.step("reorder from the keyboard: Alt+↑ moves the lecture and saves", async () => {
    const second = page.locator(".tch-lecture", { hasText: "Reverse image search" });
    await second.focus();
    const saved = page.waitForResponse((r) => /\/api\/lectures\/\d+\/$/.test(r.url()) && r.request().method() === "PUT");
    await page.keyboard.press("Alt+ArrowUp");
    expect((await saved).ok()).toBeTruthy();
    await expect(page.getByText("Moved “Reverse image search” to position 1 of 2.")).toBeAttached();
    await expect(page.locator(".tch-lecture").first()).toContainText("Reverse image search");
    await expect
      .poll(async () => {
        const body = await (await apiAs(context, "GET", `/api/courses/${courseId}/`)).json();
        return body.data.sections[0].lectures.map((lecture) => lecture.title);
      })
      .toEqual(["Reverse image search", "Search operators"]);
  });

  await test.step("free preview is a switch that saves on its own", async () => {
    const toggle = page.locator(".tch-lecture", { hasText: "Search operators" }).getByRole("switch", { name: "Free preview" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const saved = page.waitForResponse((r) => /\/api\/lectures\/\d+\/$/.test(r.url()) && r.request().method() === "PUT");
    await toggle.click();
    expect((await saved).ok()).toBeTruthy();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  await test.step("publish: one champagne action, then the status says Published", async () => {
    const published = page.waitForResponse((r) => r.url().endsWith(`/api/courses/${courseId}/`) && r.request().method() === "PATCH");
    await page.getByRole("button", { name: "Publish course" }).click();
    expect((await published).ok()).toBeTruthy();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    const body = await (await apiAs(context, "GET", `/api/courses/${courseId}/`)).json();
    expect(body.data.is_published).toBe(true);
  });

  await test.step("the list shows the course as published; old URLs land on the new pages", async () => {
    await page.goto("/console/teach/courses");
    const row = page.getByRole("row", { name: new RegExp(TITLE) }).or(page.locator(".sc-table-cards__card", { hasText: TITLE }));
    await expect(row.first()).toContainText("Published");
    await page.goto(`/instructor/courses/${courseId}/edit`);
    await expect(page).toHaveURL(new RegExp(`/console/teach/courses/${courseId}$`));
    await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
    await page.goto("/instructor/courses/new");
    await expect(page).toHaveURL(/\/console\/teach\/courses\/new$/);
  });
});

test("teach courses: with the Teachers section off, the page explains it (no redirect)", async ({ page, context, control }) => {
  const manifest = await control.reset();
  await signIn(context, manifest, "instructor");
  await page.goto("/console/teach/courses");
  await expect(page).toHaveURL(/\/console\/teach\/courses$/);
  await expect(page.getByRole("heading", { level: 1, name: "Teaching is switched off" })).toBeVisible();
  // Phones also show a header back arrow named "Back to Home"; check the page's own action.
  const offPage = page.getByRole("region", { name: "Teaching is switched off" });
  await expect(offPage.getByRole("link", { name: "Back to Home" })).toBeVisible();
});
