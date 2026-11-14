// Al Syed Admin, the Django back office (UI plan §4.8, WS-E): the job-grouped
// sidebar reaches every group and never hides under its footer, Ctrl/Cmd+K
// finds a seeded student and opens the record, the course form has tabs, and
// no back-office page scrolls sideways at 390.
import { expect, isMobile, test } from "./helpers.mjs";

const GROUPS = ["Live classes", "Content", "Students & sales", "Assessments", "Community", "Settings", "System"];

async function adminLogin(page, manifest) {
  await page.goto("/admin/login/?next=/admin/");
  await page.getByLabel(/email/i).fill(manifest.users.admin.email);
  await page.getByLabel(/password/i).fill(manifest.password);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
}

async function openNav(page, testInfo) {
  if (!isMobile(testInfo)) return;
  await page.locator("#enterprise-nav-open").click();
  await expect(page.locator("#nav-sidebar")).toBeVisible();
}

async function noSideScroll(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${page.url()} scrolls sideways`).toBeLessThanOrEqual(clientWidth);
}

test("back office: the job sidebar reaches every group and stays above its footer", async ({ page, manifest }, testInfo) => {
  await adminLogin(page, manifest);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Good (morning|afternoon|evening), Ayesha$/);
  await expect(page).toHaveTitle("Overview | Al Syed Admin");

  await openNav(page, testInfo);
  const nav = page.locator("#nav-sidebar");
  for (const group of GROUPS) {
    const summary = nav.locator("summary", { hasText: group });
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toBeVisible();
  }

  await test.step("the list scrolls in its own region above the footer", async () => {
    const footer = await nav.locator(".enterprise-sidenav-footer").boundingBox();
    const region = await nav.locator("[data-nav-scroll]").boundingBox();
    expect(region.y + region.height).toBeLessThanOrEqual(footer.y + 0.5);
    // The longest group (Assessments) opened: its last page is reachable above the footer.
    await nav.locator("summary", { hasText: "Assessments" }).click();
    const last = nav.locator('[data-nav-group="assessments"] a').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    const box = await last.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y + 0.5);
  });

  await test.step("enrolment requests are in the nav again, with the Console banner", async () => {
    await nav.locator("summary", { hasText: "Students & sales" }).click();
    await nav.getByRole("link", { name: "Enrolment requests", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/courses\/enrollment\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Enrolment requests");
    await expect(page.locator("[data-console-banner]")).toContainText("Daily work for this lives in Console");
    await openNav(page, testInfo);
    await expect(page.locator('[data-nav-group="students"] details')).toHaveAttribute("open", "");
    await expect(page.locator('#nav-sidebar [aria-current="page"]')).toHaveText("Enrolment requests");
  });
});

test("back office: Ctrl/Cmd+K finds a seeded student and opens the record", async ({ page, manifest }, testInfo) => {
  await adminLogin(page, manifest);
  const student = manifest.users.student1;

  if (isMobile(testInfo)) {
    await page.locator("#user-tools [data-palette-open]").click();
  } else {
    await page.keyboard.press("Control+k");
  }
  const input = page.getByRole("combobox", { name: /search people, courses, payments/i });
  await expect(input).toBeFocused();

  await test.step("Esc closes the palette and returns focus", async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#enterprise-palette")).not.toBeVisible();
    if (isMobile(testInfo)) await page.locator("#user-tools [data-palette-open]").click();
    else await page.keyboard.press("Control+k");
    await expect(input).toBeFocused();
  });

  await input.fill("sana");
  const option = page.getByRole("option", { name: new RegExp(student.name) });
  await expect(option).toBeVisible();
  await expect(page.getByRole("listbox")).toContainText("People");
  await option.click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/user/${student.id}/change/$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(student.email);
});

test("back office: course form tabs and no sideways scroll", async ({ page, manifest }) => {
  await adminLogin(page, manifest);

  await test.step("course form: Basics first, Pricing one click away", async () => {
    await page.goto(`/admin/courses/course/${manifest.course.id}/change/`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(manifest.course.title);
    const tabs = page.getByRole("navigation", { name: "Form sections" });
    await expect(tabs.getByRole("link", { name: "Basics" })).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#id_title")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Payment cards", exact: true })).toBeHidden();
    await tabs.getByRole("link", { name: "Pricing" }).click();
    await expect(page.getByRole("heading", { name: "Payment cards", exact: true })).toBeVisible();
    await expect(page.locator("#id_title")).toBeHidden();
    await expect(page.locator(".submit-row")).toBeVisible();
    await noSideScroll(page);
  });

  for (const path of ["/admin/", "/admin/payments/payment/", "/admin/courses/course/", "/admin/users/user/", "/admin/ctf/ctfattempt/"]) {
    await test.step(`${path} fits the screen`, async () => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noSideScroll(page);
    });
  }
});
