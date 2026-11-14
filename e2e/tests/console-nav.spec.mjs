// Console shell and navigation (UI overhaul plan §3.1-§3.3, WS-B): every
// role reaches every destination of its workspace, the Teach workspace
// follows the Teachers section switch (disabled with a reason while off),
// old URLs land on their new pages, and the side nav and the workspace
// switch work from the keyboard alone.
import { expect, isMobile, setFeatures, signIn, test } from "./helpers.mjs";

const TEACHING_REASON = /Teaching tools are switched off for now/;

/** The side nav (desktop) or the More sheet (phone) that holds the destinations. */
async function openMenu(page, testInfo) {
  if (!isMobile(testInfo)) return page.locator("#cds-app-side-nav");
  await page.getByRole("button", { name: "More", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "More" });
  await expect(sheet).toBeVisible();
  // Let the slide-up finish so taps land where the rows will stay.
  await sheet.evaluate((node) => Promise.all(node.closest(".cds-app-sheet").getAnimations({ subtree: true }).map((animation) => animation.finished)));
  return sheet;
}

async function closeMenu(page, testInfo) {
  if (!isMobile(testInfo)) return;
  const sheet = page.getByRole("dialog", { name: "More" });
  if (await sheet.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }
}

/** Opens an admin group (a disclosure in the side nav and in the More sheet). */
async function openGroup(menu, group) {
  const toggle = menu.getByRole("button", { name: group, exact: true });
  if ((await toggle.count()) === 0) return;
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** Clicks a destination in the side nav / tab bar / More sheet and checks where it lands. */
async function reach(page, testInfo, label, url, { tab } = {}) {
  if (isMobile(testInfo) && tab) {
    // A short tab ("Work") is named after its destination ("Coursework").
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: new RegExp(`^(${tab}|${label})`) }).click();
  } else {
    const menu = await openMenu(page, testInfo);
    await menu.getByRole("link", { name: new RegExp(`^${label}`) }).first().click();
  }
  await expect(page).toHaveURL(url);
  await closeMenu(page, testInfo);
}

test("student: the Learn workspace reaches every destination, no workspace switch", async ({ page, context, manifest }, testInfo) => {
  await signIn(context, manifest, "student1");
  await page.goto("/console");
  await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "learn");
  // No "Console" eyebrow anywhere in the chrome, one header, the bell and the avatar menu.
  await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account and settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Jump to/ })).toBeVisible();

  await reach(page, testInfo, "Courses", /\/my-courses$/, { tab: "Courses" });
  await reach(page, testInfo, "Live classes", /\/join-live$/, { tab: "Live" });
  await reach(page, testInfo, "Coursework", /\/reports$/, { tab: "Work" });
  await reach(page, testInfo, "OSINT tools", /\/osint-tools$/);
  await reach(page, testInfo, "Home", /\/console$/, { tab: "Home" });

  const menu = await openMenu(page, testInfo);
  await expect(menu.getByRole("group", { name: "Workspace" })).toHaveCount(0);
  const labs = menu.getByRole("link", { name: /^Labs/ });
  await expect(labs).toHaveAttribute("target", "_blank");
  await closeMenu(page, testInfo);

  // The current destination is marked once.
  await page.goto("/reports");
  const current = page.locator('#cds-app-side-nav [aria-current="page"], .cds-app-bottom-nav [aria-current="page"]');
  await expect(current).toHaveCount(1);
});

test("instructor: Teach is disabled with a reason while off, and opens when the admin turns it on", async ({ page, context, control, manifest }, testInfo) => {
  await setFeatures(control, { teaching: false });
  await signIn(context, manifest, "instructor");
  await page.goto("/console");
  let menu = await openMenu(page, testInfo);
  const workspace = menu.getByRole("group", { name: "Workspace" });
  const teach = workspace.getByRole("button", { name: /Teach/ });
  await expect(teach).toHaveAttribute("aria-disabled", "true");
  // aria-disabled (not disabled): still focusable and pressable, it explains itself.
  await teach.click({ force: true });
  await expect(menu.locator(".cds-app-workspace__reason")).toHaveText(TEACHING_REASON);
  await expect(page).toHaveURL(/\/console$/);
  await closeMenu(page, testInfo);

  // The old teaching URL explains itself instead of bouncing to the website.
  await page.goto("/instructor/dashboard");
  await expect(page.getByRole("heading", { name: "Teaching is switched off" })).toBeVisible();

  await setFeatures(control, { teaching: true });
  await page.goto("/console");
  menu = await openMenu(page, testInfo);
  const enabled = menu.getByRole("group", { name: "Workspace" }).getByRole("button", { name: /Teach/ });
  await expect(enabled).not.toHaveAttribute("aria-disabled", "true");
  await enabled.click();
  await expect(page).toHaveURL(/\/console\/teach$/);
  await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "teach");
  await closeMenu(page, testInfo);

  await reach(page, testInfo, "Grading", /\/console\/teach\/grading$/, { tab: "Grading" });
  await reach(page, testInfo, "Classes", /\/console\/teach\/classes$/, { tab: "Classes" });
  await reach(page, testInfo, "Recordings", /\/console\/teach\/recordings$/, { tab: "Recordings" });
  await reach(page, testInfo, "Courses", /\/console\/teach\/courses$/);
  await reach(page, testInfo, "Exams", /\/console\/teach\/exams$/);
  await reach(page, testInfo, "Today", /\/console\/teach$/, { tab: "Today" });
});

test("staff: the Admin workspace groups every job, and old URLs land on the new pages", async ({ page, context, manifest }, testInfo) => {
  await signIn(context, manifest, "admin");
  await page.goto("/console/admin");
  await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "admin");

  const groups = {
    "Live classes": [["Classes & studio", /\/console\/admin\/classes$/]],
    Content: [
      ["Courses", /\/console\/admin\/courses$/],
      ["Recordings", /\/console\/admin\/recordings$/],
      ["Upload", /\/console\/admin\/recordings\/upload$/],
    ],
    "Students & sales": [["Requests", /\/console\/admin\/requests$/]],
    Assessments: [
      ["Grading", /\/console\/admin\/grading$/],
      ["Exams", /\/console\/admin\/exams$/],
    ],
    Community: [["Questions", /\/console\/admin\/community\?tab=questions$/]],
    Settings: [["Features", /\/console\/admin\/settings\/features$/]],
    System: [["Health", /\/console\/admin\/system\/health$/]],
    Today: [
      ["Activity", /\/console\/admin\/activity$/],
      ["Home", /\/console\/admin$/],
    ],
  };
  // On phones Home, Classes & studio and Grading are tabs, not More rows.
  const tabs = new Set(isMobile(testInfo) ? ["Home", "Classes & studio", "Grading"] : []);
  for (const [group, items] of Object.entries(groups)) {
    for (const [label, url] of items) {
      if (tabs.has(label)) continue;
      const menu = await openMenu(page, testInfo);
      await openGroup(menu, group);
      await menu.getByRole("link", { name: new RegExp(`^${label.replace(/[&]/g, "\\&")}`) }).first().click();
      await expect(page, `${group} › ${label}`).toHaveURL(url);
      await closeMenu(page, testInfo);
    }
  }

  // Wave-2 jobs open the back office in a new tab.
  const menu = await openMenu(page, testInfo);
  await openGroup(menu, "Students & sales");
  await expect(menu.getByRole("link", { name: /^Payments/ })).toHaveAttribute("href", /\/admin\/payments\/payment\/$/);
  await closeMenu(page, testInfo);

  // The phone tab bar: Home · Live · Grading · Search.
  if (isMobile(testInfo)) {
    const bar = page.getByRole("navigation", { name: "Main navigation" });
    await bar.getByRole("link", { name: /^Grading/ }).click();
    await expect(page).toHaveURL(/\/console\/admin\/grading$/);
    await bar.getByRole("link", { name: /^Live/ }).click();
    await expect(page).toHaveURL(/\/console\/admin\/classes$/);
    await bar.getByRole("link", { name: /^Home/ }).click();
    await expect(page).toHaveURL(/\/console\/admin$/);
    await expect(bar.getByRole("button", { name: "Search" })).toBeVisible();
  }

  // Old URLs: Control center is gone, the upload page moved, Teach links open Admin.
  await page.goto("/control-center");
  await expect(page).toHaveURL(/\/console\/admin$/);
  await page.goto("/console/recordings/upload");
  await expect(page).toHaveURL(/\/console\/admin\/recordings\/upload$/);
  await page.goto("/console/teach/grading");
  await expect(page).toHaveURL(/\/console\/admin\/grading$/);
  // Students never land on the website home from a staff URL.
  await context.clearCookies();
  await signIn(context, manifest, "student1");
  await page.goto("/meeting");
  await expect(page.getByRole("heading", { name: "This page does not exist" })).toBeVisible();
  await expect(page).toHaveURL(/\/meeting$/);
});

test("keyboard only: skip link, workspace switch and side nav", async ({ page, context, manifest }, testInfo) => {
  test.skip(isMobile(testInfo), "The side nav is a desktop control; phones use the tab bar.");
  await signIn(context, manifest, "admin");
  await page.goto("/console/admin");

  const focusedText = () => page.evaluate(() => (document.activeElement?.textContent || "").trim());
  async function tabTo(predicate, limit = 60) {
    for (let step = 0; step < limit; step += 1) {
      await page.keyboard.press("Tab");
      if (predicate(await focusedText())) return;
    }
    throw new Error("focus never reached the target");
  }

  // The first stop on a fresh page is the skip link (once the shell has rendered).
  await expect(page.locator("#cds-app-side-nav")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await focusedText()).toBe("Skip to main content");

  // Open a group and follow a link with Enter.
  await tabTo((text) => text === "Students & sales");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Students & sales", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  expect(await focusedText()).toMatch(/^Requests/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/console\/admin\/requests$/);

  // The workspace switch: Learn with Enter.
  await page.goto("/console/admin/requests");
  await expect(page.locator("#cds-app-side-nav")).toBeVisible();
  await tabTo((text) => text === "Learn");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/console$/);
  await expect(page.locator(".cds-app")).toHaveAttribute("data-workspace", "learn");
});
