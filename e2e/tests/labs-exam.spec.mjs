// Labs sign-in round trip and an exam: the student opens labs signed out,
// signs in on the LMS and comes straight back, starts the exam, answers one
// question wrong then right, finishes; staff see every recorded attempt (with
// the wrong answer) in the Console and in Django admin, and the score.
import { expect, LABS, newUserContext, signIn, test, WEB } from "./helpers.mjs";

// The stack's ports come from E2E_*_PORT, so expected URLs are built from them.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


async function answer(page, key, value) {
  const card = page.locator(`#exam-q-${key}`);
  await card.locator(".answer-input").fill(value);
  const recorded = page.waitForResponse((r) => /\/api\/ctf\/.*attempt/.test(r.url()) && r.request().method() === "POST");
  await card.getByRole("button", { name: /submit/i }).click();
  expect((await recorded).status()).toBeLessThan(500);
  return card;
}

test("labs: sign-in round trip, exam attempts recorded, staff see results", async ({ page, context, manifest, browser, pageErrors }) => {
  page.on("dialog", (dialog) => dialog.accept()); // "Start the examination now?" / "Submit the examination now?"

  await test.step("signed out on labs: the exam tab sends the student to the LMS login", async () => {
    await page.goto(`${LABS}/#exam`);
    await expect(page.getByText("Sign in to the LMS to take the examination.")).toBeVisible();
    const signInLink = page.getByRole("link", { name: /sign in at/i });
    await expect(signInLink).toHaveAttribute(
      "href",
      new RegExp(`/login\\?next=${escapeRegExp(encodeURIComponent(`${LABS}/#exam`))}`)
    );
    await signInLink.click();
    await expect(page).toHaveURL(new RegExp(`^${escapeRegExp(WEB)}/login\\?next=`));
  });

  await test.step("signing in on the LMS returns to labs, signed in", async () => {
    await page.getByLabel("Email").fill(manifest.users.student1.email);
    await page.getByLabel("Password", { exact: true }).fill(manifest.password);
    await page.getByRole("button", { name: /^Login$/ }).click();
    await expect(page).toHaveURL(`${LABS}/#exam`);
    await expect(page.getByText(manifest.exam.title)).toBeVisible();
    await expect(page.getByText("Sign in to the LMS to take the examination.")).toBeHidden();
  });

  await test.step("start, a wrong answer, then right answers, then finish", async () => {
    // The exam card opens the exam page; its Start button starts the timer.
    await page.locator(`button[data-action="open"][data-slug="${manifest.exam.slug}"]`).click();
    await expect(page.getByText("Ready when you are")).toBeVisible();
    // The paper opens with the candidate block: roll number, real name, handle, stats (read-only).
    const candidate = page.getByTestId("exam-identity");
    await expect(candidate).toBeVisible();
    await expect(candidate).toContainText(`AL-SYD-${String(manifest.users.student1.id).padStart(5, "0")}`);
    await expect(candidate).toContainText(manifest.users.student1.name);
    await expect(candidate.locator("input, textarea")).toHaveCount(0);
    await page.locator('button[data-action="start"]').click();
    await expect(page.locator("#exam-q-first-handle")).toBeVisible();
    await expect(page.getByTestId("exam-identity")).toContainText("HANDLE AT START");

    const first = await answer(page, "first-handle", "wrong_handle_99");
    await expect(first.locator(".feedback-text")).toContainText("[-] Incorrect.");
    await expect(first.locator(".exam-attempts")).toContainText("Attempts: 1 /");
    await answer(page, "first-handle", manifest.exam_answers["first-handle"]);
    await expect(first.locator(".feedback-text")).toContainText("[+] Correct. +10 points recorded.");
    const second = await answer(page, "second-city", "lahore"); // normalised (case-insensitive)
    await expect(second.locator(".feedback-text")).toContainText("[+] Correct. +20 points recorded.");

    await page.getByRole("button", { name: "Submit examination" }).click();
    await expect(page.getByText(/Final score: 30 \/ 30 points \(2 solved\)/)).toBeVisible();
  });

  await test.step("staff see the attempts and the score (Console and Django admin)", async () => {
    const staff = await newUserContext(browser, test.info(), pageErrors, "staff");
    await signIn(staff, manifest, "admin");
    const console_ = await staff.newPage();
    await console_.goto(`/console/admin/exams/${manifest.exam.slug}`);
    await expect(console_.getByText("Results (out of 30)")).toBeVisible();
    // Owner rule (Console): roll number · @handle lead the row (never the real name), then rank and the record.
    await expect(console_.getByText(manifest.users.student1.name)).toHaveCount(0);
    await expect(
      console_.getByRole("row", { name: /AL-SYD-\d{5}( · @\S+| \(no handle\)) 1 OSINT Foundations Submitted 30 2 1/ })
    ).toBeVisible();
    // Wrong-answer clusters (normalised) per question.
    await expect(console_.getByRole("row", { name: /Q1\. Find the handle 100% \(1\/1\) wronghandle99 ×1/ })).toBeVisible();

    // Django admin (session login) lists every recorded attempt.
    const admin = await staff.newPage();
    await admin.goto("/admin/login/?next=/admin/ctf/ctfattempt/");
    await admin.getByLabel(/email/i).fill(manifest.users.admin.email);
    await admin.getByLabel(/password/i).fill(manifest.password);
    await admin.getByRole("button", { name: /log in/i }).click();
    await expect(admin).toHaveURL(/\/admin\/ctf\/ctfattempt\//);
    const rows = admin.locator("#result_list tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(admin.locator("#result_list")).toContainText("wrong_handle_99");
    await staff.close();
  });
});

test("labs: a student outside the batch sees why the exam is locked", async ({ page, context, manifest }) => {
  await signIn(context, manifest, "outsider");
  await page.goto(`${LABS}/#exam`);
  await expect(page.getByText("You are not in a batch yet. Enrol in a course to take its examinations.")).toBeVisible();
  await expect(page.getByRole("button", { name: /start examination/i })).toHaveCount(0);
});
