// /courses (PHILOSOPHY T3): filter chips (wrap, links), the live view
// (?view=live and the /live-classes redirect), labs deep links and no
// sideways scroll on phones.
import { expect, test } from "./helpers.mjs";

test("catalogue: chips filter by tier and track, the live view and labs deep links work", async ({ page, manifest }) => {
  await page.goto("/courses");
  await expect(page.getByRole("heading", { level: 1, name: /Pick what to learn/ })).toBeVisible();
  await expect(page.getByText(manifest.course.title).first()).toBeVisible();
  // The free tier deep-links each lab tab (01-04); the exam (05) is not offered as free.
  await expect(page.locator('a[href$="/#hub"]')).toHaveCount(1);
  await expect(page.locator('a[href$="/#certification"]')).toHaveCount(1);
  await expect(page.locator('a[href$="/#exam"]')).toHaveCount(0);

  const chips = page.getByRole("navigation", { name: "Filter courses" });
  await chips.getByRole("link", { name: "Quick wins" }).click();
  await expect(page).toHaveURL(/tier=quick_wins/);
  await expect(chips.getByRole("link", { name: "Quick wins" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 3, name: "Quick wins" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Foundations", exact: true })).toHaveCount(0);

  await chips.getByRole("link", { name: "OSINT" }).click();
  await expect(page).toHaveURL(/category=osint/);
  await expect(page.getByText(manifest.course.title).first()).toBeVisible();

  await page.goto("/live-classes");
  await expect(page).toHaveURL(/\/courses\?view=live/);
  await expect(page.getByRole("heading", { name: "Live classes" })).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no sideways scroll").toBeLessThanOrEqual(0);
});
