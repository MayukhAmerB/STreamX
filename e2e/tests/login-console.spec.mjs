// Sign in through the real form and land in the Console: students see their
// course, the open exam and their tools; staff also see the staff areas.
import { expect, isMobile, signInWithForm, test } from "./helpers.mjs";

async function openConsoleMenu(page, testInfo) {
  if (!isMobile(testInfo)) return;
  // Phone layout: a bottom tab bar; the full menu is behind "More".
  await page.getByRole("button", { name: "More", exact: true }).click();
}

test("login -> console (student, staff, wrong password)", async ({ page, context, manifest }, testInfo) => {
  await test.step("a wrong password is refused with a message", async () => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(manifest.users.student1.email);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: /^Login$/ }).click();
    await expect(page.getByText(/invalid|incorrect|unable|failed/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  await test.step("student signs in and opens the Console", async () => {
    await signInWithForm(page, manifest, "student1", { path: "/login?next=%2Fconsole" });
    await expect(page).toHaveURL(/\/console$/);
    await expect(page.getByRole("heading", { name: /Welcome back, Sana/ })).toBeVisible();
    await expect(page.getByText(manifest.course.title).first()).toBeVisible();
    await expect(page.getByText(manifest.exam.title)).toBeVisible(); // "Exam open now" card
    await openConsoleMenu(page, testInfo);
    await expect(page.getByRole("link", { name: /^Reports/ }).first()).toBeAttached();
    await expect(page.getByRole("link", { name: "Report grading" })).toHaveCount(0);
  });

  await test.step("staff sign in and see the staff areas", async () => {
    await context.clearCookies();
    await signInWithForm(page, manifest, "admin", { path: "/login?next=%2Fconsole" });
    await expect(page).toHaveURL(/\/console$/);
    await openConsoleMenu(page, testInfo);
    for (const name of ["Report grading", "Exams", "Broadcasting"]) {
      await expect(page.getByRole("link", { name, exact: true }).first()).toBeAttached();
    }
  });

  await test.step("signed-out visitors are sent to the login page", async () => {
    await context.clearCookies();
    await page.goto("/console");
    await expect(page).toHaveURL(/\/login/);
  });
});
