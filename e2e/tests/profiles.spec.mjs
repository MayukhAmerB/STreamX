// Student profiles (WS-PROFILES): a student builds a block-based profile in
// the Console, the server-side PII guard blocks publishing a phone number,
// the student fixes it and publishes; others see exactly the published page
// at /u/<handle> under a handle (never the real name); a member reports it,
// a moderator hides it, and with the `public_profiles` switch off the page
// says "coming soon". Images are re-encoded and served through the API.
import fs from "node:fs";
import path from "node:path";

import { apiAs, expect, isMobile, newUserContext, setFeatures, signIn, test } from "./helpers.mjs";

const SHOTS = process.env.E2E_SHOTS_DIR || "";
// A 96x96 PNG (our own drawing).
const AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAACBUlEQVR42u3dzXHCMBCGYXvHFbgBWqACd8JwyJ1icufApBMqoAU6ydUjjxNi9O2unFc3MqDYD6u1rB/Tj+PYUdaLQQAQQAABBBBAADmVaZoAIoIAAogCEEAAAQRQ/jKEH8HzcZu/PF2uxV8Ox/O/AyoIXn+zP9aQmWbt455Mvc+g/Q8uxdlO03S/37d9ttUIWp7hn05s/uaiqufjpjYaMtOsYc2rVTc6c9M5HM+1TmNZ1ZupLQCouPQovuGiWpGROehIW7HayJrWcTAykY6oWb3S3OoamUgnpIOuMLIkXeRsXfbKQLG3S9J8ZLrjy2CUAig89UiTke0s9VQ/QttT41IcD0OuSqCE2ad6JiKCZEDJw6dWEBFBAAGUEaiJBFQlDRFBAAEEEEAAAQQQQBSAHIFE05idckx6210REQQQQEmBmkhD7w/LEEFKoORBVGVUjwhifVAsUENj0mERlDATVZxTsJyBnecYrInFyoGLAVkf5NjEwpORYjrTdNOYnkzzf5duEWd4PpIuQrYWN5h4LtE2nwXdCqaiWtFVwtyuIxWZllXprqGDw7W24g7K6ns8U2zqPRzPy824r59h7K7n3vlZrr+2stPl+vX5kadTOoR0cDcno/0/eWFDPyD2JqbP9rjk5ZMXOqZ9OubFAAIIIApAAAEEULrS88MjRBBAAAEEEEB7Ld+fGv9QxpjEBgAAAABJRU5ErkJggg==",
  "base64"
);

async function shot(page, testInfo, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const width = page.viewportSize()?.width || (isMobile(testInfo) ? 390 : 1440);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true, animations: "disabled" });
}

test("student profiles: build, PII guard, publish, view by handle, report, moderate, switch off", async ({ page, control, browser, pageErrors }, testInfo) => {
  test.setTimeout(180_000);
  const manifest = await control.reset();
  await setFeatures(control, { public_profiles: true, engagement: true });
  await signIn(page.context(), manifest, "student1");

  // The editor: a handle-only profile is created on first visit.
  await page.goto("/profile/public");
  await expect(page.getByRole("heading", { level: 1, name: "Your profile page" })).toBeVisible();
  const me = await (await apiAs(page.context(), "GET", "/api/profiles/me/")).json();
  const handle = me.data.handle;
  expect(handle).toMatch(/^[a-z]+_[a-z]+_\d{4}$/);
  expect(handle).not.toContain("sana");

  await page.getByRole("textbox", { name: "Display name" }).fill("Quiet Falcon");
  await page.getByRole("textbox", { name: "Tagline" }).fill("Learning to find what others miss");
  await page.getByRole("textbox", { name: "About text" }).fill("I study **OSINT** and geolocation.\nWhatsApp me on +91 98765 43210");

  // Avatar upload: virus-scanned, re-encoded, then used in the header.
  await page.locator('input[type="file"]').first().setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: AVATAR_PNG });
  await expect(page.getByText("Image checked and added.")).toBeVisible();

  // Publishing is refused by the server with the reason; nothing goes public.
  await page.getByRole("button", { name: "Publish" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Personal details found" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("a phone number");
  await expect(alert).not.toContainText("98765 43210");
  const viewer = await newUserContext(browser, testInfo, pageErrors, "student2");
  await signIn(viewer, manifest, "student2");
  const visitor = await viewer.newPage();
  await visitor.goto(`/u/${handle}`);
  await expect(visitor.getByRole("heading", { level: 1, name: "Profile not found" })).toBeVisible();

  // Raw HTML is refused (sanitisation), then the clean text publishes.
  await page.getByRole("textbox", { name: "About text" }).fill("<script>alert(1)</script>");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
  await page.getByRole("textbox", { name: "About text" }).fill("I study **OSINT** and geolocation.\n\n- Shadows\n- Street furniture");
  await page.getByRole("button", { name: "Add a skill" }).click();
  await page.getByRole("textbox", { name: "Skill", exact: true }).fill("Image geolocation");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Published. Your page now shows this version.")).toBeVisible();
  await shot(page, testInfo, "profile-editor");
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /Quiet Falcon/ })).toBeVisible();
  await page.getByRole("tab", { name: "Privacy" }).click();
  await shot(page, testInfo, "profile-editor-privacy");

  // Members-only by default: another member sees it; an anonymous visitor is asked to sign in.
  await visitor.goto(`/u/${handle}`);
  await expect(visitor.getByRole("heading", { level: 1, name: /Quiet Falcon/ })).toBeVisible();
  await expect(visitor.getByText(`@${handle}`)).toBeVisible();
  await expect(visitor.getByText("Sana Student")).toHaveCount(0);
  await expect(visitor.getByRole("heading", { level: 2, name: "About" })).toBeVisible();
  await expect(visitor.getByText("Image geolocation")).toBeVisible();
  await expect(visitor.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await shot(visitor, testInfo, "profile-public");

  const anonymous = await newUserContext(browser, testInfo, pageErrors, "anonymous");
  const stranger = await anonymous.newPage();
  await stranger.goto(`/u/${handle}`);
  await expect(stranger.getByRole("link", { name: "Sign in to view" })).toBeVisible();
  await shot(stranger, testInfo, "profile-members-only");

  // The owner opens it to everyone.
  await page.getByRole("radio", { name: "Anyone with the link" }).click();
  await expect(page.getByText("Privacy settings saved.")).toBeVisible();
  await stranger.goto(`/u/${handle}`);
  await expect(stranger.getByRole("heading", { level: 1, name: /Quiet Falcon/ })).toBeVisible();
  await expect(stranger.getByRole("button", { name: "Report profile" })).toHaveCount(0);

  // A member reports it; a moderator hides it (it disappears); the owner sees why.
  await visitor.goto(`/u/${handle}`);
  await visitor.getByRole("button", { name: "Report profile" }).click();
  await visitor.getByRole("radio", { name: "Shares personal information" }).check();
  await visitor.getByRole("button", { name: "Send report" }).click();
  await expect(visitor.getByText("Thanks. A moderator will review this profile.")).toBeVisible();
  await visitor.getByRole("button", { name: "Done" }).click();

  const staff = await newUserContext(browser, testInfo, pageErrors, "admin");
  await signIn(staff, manifest, "admin");
  const queue = await (await apiAs(staff, "GET", "/api/profiles/moderation/reports/")).json();
  expect(queue.data.reports.map((row) => row.handle)).toContain(handle);
  const hidden = await apiAs(staff, "POST", `/api/profiles/moderation/profiles/${handle}/hide/`, { data: { reason: "Checking a report" } });
  expect(hidden.ok()).toBeTruthy();
  await visitor.goto(`/u/${handle}`);
  await expect(visitor.getByRole("heading", { level: 1, name: "Profile not found" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Hidden by a moderator").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toHaveAttribute("aria-disabled", "true");
  expect((await apiAs(staff, "POST", `/api/profiles/moderation/profiles/${handle}/restore/`, { data: {} })).ok()).toBeTruthy();

  // Switch off: the page says "coming soon"; data is kept.
  await setFeatures(control, { public_profiles: false });
  await stranger.goto(`/u/${handle}`);
  await expect(stranger.getByRole("heading", { level: 1, name: "Student profiles are coming soon" })).toBeVisible();
  await page.goto("/profile/public");
  await expect(page.getByText("Student profiles are coming soon", { exact: true })).toBeVisible();
  await shot(stranger, testInfo, "profile-off");

  await viewer.close();
  await anonymous.close();
  await staff.close();
});
