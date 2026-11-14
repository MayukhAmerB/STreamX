// /pricing (owner OSINT membership rules): Free is the only plan you can start
// today ("Start free" → the free OSINT directory); Starter, the CTF Labs
// membership and the Pentesting plans are disabled with a reason, and no
// unconfirmed price is ever shown.
import { expect, test } from "./helpers.mjs";

test("pricing: Start free works, paid plans are disabled with a reason, no unconfirmed price", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { level: 1, name: /Begin free/ })).toBeVisible();

  const free = page.locator('[data-plan="free"]');
  await expect(free).toHaveAttribute("data-state", "available");
  const start = free.getByRole("link", { name: /Start free/ });
  await expect(start).toHaveAttribute("href", "/osint/free");

  for (const key of ["starter", "ctf_labs", "bootcamp", "pentesting_membership", "lifetime"]) {
    const card = page.locator(`[data-plan="${key}"]`);
    await expect(card, key).toBeVisible();
    await expect(card).not.toHaveAttribute("data-state", "available");
    const cta = card.locator('[data-disabled-action="true"]');
    await expect(cta).toHaveAttribute("aria-disabled", "true");
    await expect(card.locator(".hp-reason")).not.toBeEmpty();
    await expect(card.getByRole("link")).toHaveCount(0);
  }
  // Exactly one golden (highlighted) plan on the page.
  await expect(page.locator(".hp-plan--highlighted")).toHaveCount(1);
  await expect(page.locator('[data-plan="ctf_labs"]')).toHaveClass(/hp-plan--highlighted/);
  // Unconfirmed prices read "Price at launch" (seeded plans are unconfirmed).
  await expect(page.locator('[data-plan="ctf_labs"]')).toContainText("Price at launch");

  // The yearly toggle is a pressed-state button group.
  const yearly = page.getByRole("button", { name: /Yearly/ });
  await yearly.click();
  await expect(yearly).toHaveAttribute("aria-pressed", "true");

  await start.click();
  await expect(page).toHaveURL(/\/osint\/free$/);
  await expect(page.getByRole("heading", { level: 1, name: /Start free/ })).toBeVisible();
  // Free challenges link out to their platform in a new tab (never re-hosted).
  const external = page.locator('.hp-dir__row a[target="_blank"]');
  if ((await external.count()) > 0) {
    await expect(external.first()).toHaveAttribute("href", /^https:\/\//);
    await expect(external.first()).toHaveAttribute("rel", /noopener/);
  }
});
