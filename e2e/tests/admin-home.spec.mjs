// Admin home (UI overhaul plan §4.4, §7.5 WS-G): a seeded pending enrolment
// appears in "Needs attention" → Review → Approve → the row leaves, the toast
// says "Approved" with Undo, and the home count drops. Ctrl/Cmd+K "pay"
// finds the seeded payment. The old Control center URL lands on the home.
import { expect, isMobile, signIn, test } from "./helpers.mjs";

const OUTSIDER = "Omar Outsider";

async function openPalette(page, testInfo) {
  if (isMobile(testInfo)) {
    // Phones: the command field on the home opens the same palette.
    await page.getByRole("button", { name: /Search people, courses, payments/ }).click();
  } else {
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Control+K");
  }
  const input = page.getByRole("combobox", { name: /Search or type an action/ });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  return input;
}

test("admin home: attention → review → approve → count drops; Ctrl+K finds a payment", async ({ page, context, control, manifest }, testInfo) => {
  const seeded = await control.fixture("admin-queues");
  expect(seeded.created?.enrolment_request?.id, JSON.stringify(seeded)).toBeTruthy();
  expect(seeded.created?.payment?.id, JSON.stringify(seeded)).toBeTruthy();
  await signIn(context, manifest, "admin");

  await test.step("the home opens on what needs the admin", async () => {
    await page.goto("/console/admin");
    await expect(page.getByRole("heading", { level: 1, name: /Good (morning|afternoon|evening), Ayesha/ })).toBeVisible();
    await expect(page.getByText(/\d+ things? needs? you/)).toBeVisible();
    const tile = page.locator('[data-queue="enrolment_requests"]');
    await expect(tile).toBeVisible();
    await expect(tile.getByRole("heading", { name: "Enrolment requests" })).toBeVisible();
    await expect(tile.getByRole("link", { name: /^Review 2: Enrolment requests/ })).toBeVisible();
    // Exactly one champagne action on the page: the busiest queue's.
    await expect(page.locator(".adm-button--accent")).toHaveCount(1);
    // Zero queues collapse into one calm line.
    await expect(page.getByTestId("attention-all-clear")).toContainText("All clear:");
    await expect(page.getByText("Teachers section")).toBeVisible();
  });

  await test.step("Review opens the Requests list", async () => {
    await page.locator('[data-queue="enrolment_requests"]').getByRole("link", { name: /^Review 2/ }).click();
    await expect(page).toHaveURL(/\/console\/admin\/requests$/);
    await expect(page.getByRole("heading", { level: 1, name: "Requests" })).toBeVisible();
    await expect(page.locator("[data-request]")).toHaveCount(2);
  });

  await test.step("Approve: the row leaves and the toast offers Undo", async () => {
    const row = page.locator("[data-request^='course_']");
    await expect(row).toContainText(OUTSIDER);
    await row.getByRole("button", { name: `Approve ${OUTSIDER}` }).click();
    const toast = page.locator(".sc-toast, .cds--toast-notification").filter({ hasText: "Approved" }).first();
    await expect(toast).toBeVisible();
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(page.locator("[data-request]")).toHaveCount(1);
  });

  await test.step("back on the home the count went down", async () => {
    await page.goto("/console/admin");
    const tile = page.locator('[data-queue="enrolment_requests"]');
    await expect(tile.getByRole("link", { name: /^Review 1: Enrolment requests/ })).toBeVisible();
  });

  await test.step("Ctrl/Cmd+K 'pay' finds the seeded payment", async () => {
    const input = await openPalette(page, testInfo);
    await input.fill("pay");
    const listbox = page.getByRole("listbox", { name: "Results" });
    const payment = listbox.getByRole("option", { name: /Order order_E2E1042/ });
    await expect(payment).toBeVisible();
    await expect(listbox.getByRole("group", { name: "Payments" })).toBeVisible();
    // Keyboard: arrows move the active option, Esc closes and gives focus back.
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[role='option'][aria-selected='true']")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
    // Opening the hit loads the back-office record.
    const again = await openPalette(page, testInfo);
    await again.fill("order_E2E1042");
    await page.getByRole("option", { name: /Order order_E2E1042/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/payments/payment/${seeded.created.payment.id}/change/`));
  });

  await test.step("the old Control center URL lands on the Admin home", async () => {
    await page.goto("/control-center");
    await expect(page).toHaveURL(/\/console\/admin$/);
  });
});
