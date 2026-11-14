// Engagement UI (console-student): Achievements, the batch Leaderboard, the
// Progress nav entries and the public certificate check. Contract:
// scratchpad/engagement-notes.md §9. E2E settings turn the `engagement`
// switch on; the last journey turns it off and expects the UI to step aside.
//
// Data comes through the staff API (XP + badges), exactly as an admin would
// award them, so nothing here depends on the async worker's timing.
import { apiAs, expect, isMobile, newUserContext, setFeatures, signIn, test } from "./helpers.mjs";

const SATURDAY_NOON = "2026-11-14T12:00:00+05:30";

async function award(staff, manifest) {
  const xp = await apiAs(staff, "POST", "/api/engagement/staff/xp/", {
    data: { user_id: manifest.users.student1.id, points: 820, reason: "E2E: achievements journey" },
  });
  expect(xp.ok(), await xp.text()).toBeTruthy();
  const other = await apiAs(staff, "POST", "/api/engagement/staff/xp/", {
    data: { user_id: manifest.users.student2.id, points: 460, reason: "E2E: achievements journey" },
  });
  expect(other.ok(), await other.text()).toBeTruthy();
  const badge = await apiAs(staff, "POST", "/api/engagement/staff/badges/", {
    data: { user_id: manifest.users.student1.id, badge_key: "first_exam", action: "award", reason: "E2E" },
  });
  expect(badge.ok(), await badge.text()).toBeTruthy();
}

/** The Learn route must be wired in AppRoutes.jsx (requests/mkt.md); a NotFound page means it is not yet. */
async function routeWired(page) {
  await page.waitForLoadState("domcontentloaded");
  const notFound = page.getByRole("heading", { level: 1, name: /could not be found|Lost the/i });
  const real = page.locator(".eg-page");
  await expect(notFound.or(real).first()).toBeVisible();
  return (await real.count()) > 0;
}

async function openProgressItem(page, testInfo, name) {
  // The nav knows the switch once capabilities have loaded with the shell.
  await expect(page.getByRole("heading", { level: 1, name: /Welcome back/ })).toBeVisible();
  if (isMobile(testInfo)) {
    await page.getByRole("button", { name: /More/ }).click();
  }
  const link = page.getByRole("link", { name, exact: true }).first();
  await expect(link).toBeVisible();
  await link.click();
}

test("achievements: earned and locked badges, rank ladder, certificate check", async ({ page, context, control, browser, pageErrors }, testInfo) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  const staff = await newUserContext(browser, testInfo, pageErrors, "staff");
  await signIn(staff, manifest, "admin");
  await award(staff, manifest);
  await staff.close();
  await signIn(context, manifest, "student1");

  await page.goto("/console");
  await openProgressItem(page, testInfo, "Achievements");
  await expect(page).toHaveURL(/\/achievements$/);
  test.skip(!(await routeWired(page)), "AppRoutes.jsx does not wire /achievements yet (requests/mkt.md)");

  await test.step("stat strip and rank card", async () => {
    await expect(page.getByRole("heading", { level: 1, name: "Achievements" })).toBeVisible();
    const strip = page.getByRole("region", { name: "Your progress in numbers" });
    await expect(strip).toContainText("820");
    await expect(page.getByRole("heading", { level: 2, name: "Operator" })).toBeVisible();
    await expect(page.getByText(/680\s*XP to Analyst/)).toBeVisible();
  });

  await test.step("badges: earned = solid card + date, locked = dashed card + Locked + criteria", async () => {
    const earned = page.locator(".eg-badge.is-earned").filter({ hasText: "First Exam" });
    await expect(earned).toContainText(/Earned \d{1,2} Nov 2026/);
    const locked = page.locator(".eg-badge.is-locked").first();
    await expect(locked).toContainText("Locked");
    expect(await locked.evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe("dashed");
    expect(await earned.evaluate((node) => getComputedStyle(node).borderTopStyle)).toBe("solid");
  });

  await test.step("tabs are keyboard operable; the current rank is marked", async () => {
    const badgesTab = page.getByRole("tab", { name: "Badges" });
    await badgesTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Ranks" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Ranks" })).toBeFocused();
    await expect(page.locator('[aria-current="step"]')).toContainText("Operator");
    await expect(page.locator('[aria-current="step"]')).toContainText("You are here");
  });

  await test.step("certificates: a public link that verifies without signing in", async () => {
    await page.getByRole("tab", { name: "Certificates" }).click();
    const cert = page.locator(".eg-cert").filter({ hasText: "First Exam" });
    await expect(cert).toBeVisible();
    await expect(cert.getByRole("link", { name: /Certificate/ })).toHaveAttribute("href", /certificate\.pdf$/);
    const list = await apiAs(context, "GET", "/api/engagement/achievements/");
    const rows = (await list.json()).data.achievements;
    const slug = rows.find((row) => row.key === "first_exam").slug;
    const visitor = await newUserContext(browser, testInfo, pageErrors, "visitor");
    const open = await visitor.newPage();
    await open.goto(`/achievements/${slug}`);
    await expect(open.getByText("First Exam").first()).toBeVisible();
    await expect(open.getByText(/Verified|valid/i).first()).toBeVisible();
    await visitor.close();
  });
});

test("leaderboard: the viewer's row is marked You, week and all-time tabs", async ({ page, context, control, browser, pageErrors }, testInfo) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  const staff = await newUserContext(browser, testInfo, pageErrors, "staff");
  await signIn(staff, manifest, "admin");
  await award(staff, manifest);
  await staff.close();
  await signIn(context, manifest, "student1");

  await page.goto("/console");
  await openProgressItem(page, testInfo, "Leaderboard");
  await expect(page).toHaveURL(/\/leaderboard$/);
  test.skip(!(await routeWired(page)), "AppRoutes.jsx does not wire /leaderboard yet (requests/mkt.md)");

  const me = page.locator("tr.is-me");
  await expect(me).toContainText("You");
  await expect(me).toContainText("820");
  await expect(me).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".eg-board-me")).toContainText("#1");
  await page.getByRole("tab", { name: "All time" }).click();
  await expect(page.getByRole("tab", { name: "All time" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("tr.is-me")).toContainText("820");
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, "no horizontal page scroll").toBeLessThanOrEqual(clientWidth + 1);
});

test("engagement switched off: Progress nav disappears, pages explain, the API answers 403", async ({ page, context, control }, testInfo) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  await setFeatures(control, { engagement: false });
  await signIn(context, manifest, "student1");

  const me = await apiAs(context, "GET", "/api/engagement/me/");
  expect(me.status()).toBe(403);
  expect((await me.json()).code).toBe("feature_disabled");

  await page.goto("/console");
  await expect(page.getByRole("heading", { level: 1, name: /Welcome back/ })).toBeVisible();
  // No stat strip and no XP toasts while the switch is off.
  await expect(page.locator(".eg-stats")).toHaveCount(0);
  if (isMobile(testInfo)) await page.getByRole("button", { name: /More/ }).click();
  await expect(page.getByRole("link", { name: "Achievements", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Leaderboard", exact: true })).toHaveCount(0);

  await page.goto("/achievements");
  if (await routeWired(page)) {
    await expect(page.getByText("Achievements are switched off for now")).toBeVisible();
    await expect(page.locator(".eg-off").getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/console");
  }
});
