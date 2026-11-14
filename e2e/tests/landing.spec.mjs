// Public website: landing links, the disabled Pentesting track, the YouTube
// Watch section (fixture feed) and the enquiry modal on an empty catalogue.
import { expect, isMobile, test } from "./helpers.mjs";

const NOT_FOUND = "This page could not be found.";

test("landing: links work, Pentesting is disabled, enquiry modal submits", async ({ page, control, manifest }, testInfo) => {
  await test.step("hero, tracks and Pentesting closed", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Learn practical cyber skills/ })).toBeVisible();
    const tracks = page.getByRole("list", { name: "Professional tracks" });
    const osint = tracks.locator('[data-track="osint"]');
    const pentesting = tracks.locator('[data-track="web_pentesting"]');
    await expect(osint).toHaveAttribute("data-state", "open");
    await expect(osint.getByRole("link")).toHaveAttribute("href", /\/courses\?category=osint/);
    await expect(pentesting).toHaveAttribute("data-state", "coming_soon");
    await expect(pentesting).toContainText("Coming soon · No courses yet");
    // Carbon disabled tile: aria-disabled, no href, so it can never navigate.
    const closedTile = pentesting.getByRole("link");
    await expect(closedTile).toBeDisabled();
    expect(await closedTile.getAttribute("href")).toBeNull();
    // Clicking the closed track goes nowhere.
    await pentesting.locator(".lp-track").click({ force: true });
    await expect(page).toHaveURL(/\/$/);
  });

  await test.step("bestsellers list the seeded course; the Watch section uses the fixture feed", async () => {
    await expect(page.getByText(manifest.course.title).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Play video: E2E: OSINT in practice/ })).toBeVisible();
  });

  await test.step("every in-site link on the landing page opens a real page", async () => {
    const hrefs = await page.$$eval("a[href^='/']", (links) => [...new Set(links.map((link) => link.getAttribute("href")))]);
    const targets = hrefs.filter((href) => !href.startsWith("/admin") && !href.startsWith("/media")).map((href) => href.split("#")[0]);
    expect(targets.length).toBeGreaterThan(8);
    for (const href of [...new Set(targets)]) {
      await page.goto(href);
      await expect(page.getByText(NOT_FOUND), `link ${href}`).toHaveCount(0);
    }
    await page.goto("/courses");
    await expect(page.getByText("Coming soon · No courses yet")).toBeVisible();
    await expect(page.getByText(manifest.course.title).first()).toBeVisible();
  });

  await test.step("header navigation (mobile: slide-out menu)", async () => {
    await page.goto("/");
    if (isMobile(testInfo)) {
      await page.getByRole("button", { name: "Open navigation menu" }).click();
    }
    await page.getByRole("link", { name: "Courses", exact: true }).first().click();
    await expect(page).toHaveURL(/\/courses$/);
  });

  await test.step("empty catalogue: the enquiry modal submits a lead", async () => {
    await control.fixture("no-courses");
    await page.goto("/");
    await page.getByRole("button", { name: "Submit an enquiry" }).click();
    // An accessible modal: role="dialog", aria-modal, named by its heading.
    const dialog = page.getByRole("dialog", { name: "Enrollment Enquiry" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await dialog.getByLabel("Email").fill("prospect@e2e.test");
    await dialog.getByLabel("Whatsapp Number").fill("+91 98765 43210");
    await dialog.getByLabel("Phone Number").fill("+91 98765 43210");
    await dialog.getByLabel("What Access Do You Need?").fill("The next OSINT batch, please.");
    const sent = page.waitForResponse((r) => r.url().includes("/api/enrollment-leads/") && r.request().method() === "POST");
    await dialog.getByRole("button", { name: "Submit Request" }).click();
    expect((await sent).status()).toBeLessThan(300);
    await expect(dialog.getByText(/submitted|received|thank/i)).toBeVisible();
    const leads = await control.fixture("leads");
    expect(leads.count).toBe(1);
    expect(leads.leads[0].email).toBe("prospect@e2e.test");
  });
});
