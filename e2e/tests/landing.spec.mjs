// Public website: landing links, Pentesting browsable but closed for purchase, the YouTube
// Watch section (fixture feed) and the enquiry modal on an empty catalogue.
import { expect, isMobile, signInWithForm, test } from "./helpers.mjs";

const NOT_FOUND = "This page could not be found.";

test("landing: links work, Pentesting is browsable but closed, enquiry modal submits", async ({ page, control, manifest }, testInfo) => {
  await test.step("hero (calligraphy), tracks and Pentesting closed for purchase", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /Learn to investigate/ })).toBeVisible();
    // The golden calligraphy (Qur'an 20:114) with its translation and attribution.
    await expect(page.getByRole("img", { name: /Qur'an 20:114/ })).toBeVisible();
    await expect(page.getByText("And say: My Lord, increase me in knowledge")).toBeVisible();
    const tracks = page.getByRole("list", { name: "Professional tracks" });
    const osint = tracks.locator('[data-track="osint"]');
    const pentesting = tracks.locator('[data-track="web_pentesting"]');
    await expect(osint).toHaveAttribute("data-state", "open");
    await expect(osint.getByRole("link")).toHaveAttribute("href", "/tracks/osint");
    // Owner rule: Pentesting is browsable but not purchasable while the switch is off.
    await expect(pentesting).toHaveAttribute("data-state", "coming_soon");
    await expect(pentesting).toContainText("Coming soon");
    await pentesting.getByRole("link").click();
    await expect(page).toHaveURL(/\/tracks\/pentesting$/);
    const enrol = page.locator('[data-disabled-action="true"]').first();
    await expect(enrol).toHaveAttribute("aria-disabled", "true");
    await expect(enrol).toContainText("Enrol (coming soon)");
    await enrol.click({ force: true });
    await expect(page).toHaveURL(/\/tracks\/pentesting$/);
    await page.goto("/");
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
    await expect(page.getByText("Pentesting is coming soon").first()).toBeVisible();
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

test("landing: reduced motion shows the finished page with nothing looping", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /Learn to investigate/ })).toBeVisible();
  await page.evaluate(() => document.fonts?.ready);
  const running = () =>
    page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => animation.playState === "running" && animation.effect?.getTiming?.().iterations === Infinity)
        .map((animation) => animation.animationName || animation.constructor.name)
    );
  expect(await running(), "infinite animations at the top of /").toEqual([]);
  // Scroll through every band: still nothing loops, and the key figures show their final values.
  await page.locator(".lp-stats").scrollIntoViewIfNeeded();
  await expect(page.locator(".lp-stats")).toContainText("1000+");
  expect(await running(), "infinite animations after scrolling /").toEqual([]);
  // The hero artwork is shown from the start (no fade-in: fully opaque under reduced motion).
  const opacity = await page.locator(".hp-calligraphy img").evaluate((node) => getComputedStyle(node).opacity);
  expect(opacity).toBe("1");
});

test("login: staff land in Admin and students in the Console without a return address", async ({ page, context, manifest }) => {
  await signInWithForm(page, manifest, "student1");
  await expect(page).toHaveURL(/\/console$/);
  await context.clearCookies();
  await signInWithForm(page, manifest, "admin");
  await expect(page).toHaveURL(/\/console\/admin$/);
});
