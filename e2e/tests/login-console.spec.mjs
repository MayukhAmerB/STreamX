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
    await expect(page.getByText(manifest.exam.title).first()).toBeVisible(); // the open exam (Next up / Also this week)
    // Learn workspace: the coursework hub is a destination (tab "Work" on phones).
    await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "learn");
    await expect(page.getByRole("link", { name: /^(Coursework|Work)/ }).first()).toBeVisible();
    await openConsoleMenu(page, testInfo);
    // Students never see staff or teaching tools, and get no workspace switch.
    for (const name of [/^Report grading$/, /^Grading$/, /^Classes( & studio)?$/, /^Requests/]) {
      await expect(page.getByRole("link", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("group", { name: "Workspace" })).toHaveCount(0);
  });

  await test.step("staff sign in and land on Admin home with the staff jobs grouped", async () => {
    await context.clearCookies();
    await signInWithForm(page, manifest, "admin");
    // Staff land on Admin home (plan D3), which opens on what needs them.
    await expect(page).toHaveURL(/\/console\/admin$/);
    await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "admin");
    await expect(page.getByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
    await openConsoleMenu(page, testInfo);
    // Grading and Exams live in the Assessments group (collapsed unless current).
    const assessments = page.getByRole("button", { name: "Assessments", exact: true });
    if ((await assessments.getAttribute("aria-expanded")) !== "true") await assessments.click();
    for (const name of [/^Grading/, /^Exams/]) {
      await expect(page.getByRole("link", { name }).first()).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Live classes", exact: true })).toBeVisible();
  });

  await test.step("an old staff URL still opens the page (Exams, Admin workspace)", async () => {
    await page.goto("/console/exams");
    // The redirect flips to /console/admin/exams when WS-B switches it on; either way Exams opens.
    await expect(page).toHaveURL(/\/console\/(admin\/)?exams$/);
    await expect(page.getByRole("heading", { level: 1, name: /Exams/ })).toBeVisible();
  });

  await test.step("signed-out visitors are sent to the login page", async () => {
    await context.clearCookies();
    await page.goto("/console");
    await expect(page).toHaveURL(/\/login/);
  });
});
