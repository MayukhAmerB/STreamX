// Console Home "Next up", Teach > Today and the Learn pages (UI overhaul
// plan §3.4/§3.5, WS-C). Clock frozen on Saturday 14 Nov 2026, 12:00 IST:
// the seeded exam is open and this week's report is due Sunday 23:59 IST.
//
//  - student: Next up is the open exam ("Start exam"), the report due
//    tomorrow is an "Also this week" row, the course is a card; a class going
//    live moves "Join live" to the top; the action is above the fold at 390.
//  - no-course user: "You're not enrolled yet · Browse courses", no countdown.
//  - instructor with Teaching on: Teach > Today lists the jobs with counts.
//  - Learn pages: /reports/marks lands on Coursework › Grades, Profile
//    "Reduce motion" sets <html data-motion="reduce">, OSINT tools stays
//    short at 390, the player never scrolls sideways.
//
// Set WS_C_SHOTS=<dir> to also save 390/1440 viewport screenshots.
import fs from "node:fs";
import path from "node:path";

import { apiAs, expect, isMobile, newUserContext, setFeatures, signIn, test } from "./helpers.mjs";

const SATURDAY_NOON = "2026-11-14T12:00:00+05:30";
const SHOTS = process.env.WS_C_SHOTS || "";

async function shot(page, name) {
  if (!SHOTS) return;
  const dir = path.join(SHOTS, test.info().project.name);
  fs.mkdirSync(dir, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400); // entrance motion and image fade settle
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  await page.screenshot({ path: path.join(dir, `${name}-full.png`), fullPage: true });
}

const nextUp = (page) => page.locator("section.ch-next");

/** The Next up action must be on screen without scrolling (390×844 and 1440×900). */
async function expectActionAboveFold(page, action) {
  await expect(action).toBeVisible();
  const box = await action.boundingBox();
  const viewport = page.viewportSize();
  expect(box.y + box.height, "Next up action is visible without scrolling").toBeLessThanOrEqual(viewport.height);
}

async function pageHeight(page) {
  return page.evaluate(() => document.documentElement.scrollHeight);
}

async function noSidewaysScroll(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, "no horizontal page scroll").toBeLessThanOrEqual(clientWidth + 1);
}

test("home: Next up for a student, live now first, action above the fold", async ({ page, context, control, browser, pageErrors }, testInfo) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  await signIn(context, manifest, "student1");

  await test.step("open exam is Next up; the report due tomorrow and the course follow", async () => {
    await page.goto("/console");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, Sana" })).toBeVisible();
    const card = nextUp(page);
    await expect(card).toHaveAttribute("data-kind", "exam_open");
    await expect(card.getByRole("heading", { name: manifest.exam.title })).toBeVisible();
    const start = card.getByRole("link", { name: /Start exam/ });
    await expect(start).toHaveAttribute("target", "_blank");
    await expectActionAboveFold(page, start);
    const also = page.getByRole("region", { name: "Also this week" }).or(page.locator("section").filter({ has: page.getByRole("heading", { name: "Also this week" }) }));
    await expect(also.getByText("Week of 9–15 Nov")).toBeVisible();
    await expect(also.getByText(/Due Tomorrow 11:59 pm/)).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(manifest.course.title) }).first()).toBeVisible();
    // No stat chips, no shortcut tiles, one champagne action.
    await expect(page.locator(".uc-tile, .cds-stat-chip")).toHaveCount(0);
    await expect(page.locator(".ch-accent-button")).toHaveCount(1);
    // HackPath Home (console-student): the first name is the one handwritten word;
    // Practice shows the labs (open while `labs_membership_required` is off) and the
    // Pentesting track (browsable, purchases "Coming soon" while `pentesting` is off).
    await expect(page.locator("h1 .ch-hand")).toHaveText("Sana");
    const labs = page.getByTestId("home-labs-card");
    await expect(labs).toHaveAttribute("href", /labs/);
    await expect(labs).toHaveAttribute("target", "_blank");
    await expect(labs).toContainText("Open now");
    const pentesting = page.getByTestId("home-pentesting-card");
    await expect(pentesting).toHaveAttribute("href", "/tracks/pentesting");
    await expect(pentesting).toContainText("Coming soon");
    // Free tier (owner OSINT rules): the free challenge directory, never the labs.
    const free = page.getByTestId("home-free-directory-card");
    await expect(free).toHaveAttribute("href", "/osint/free");
    await expect(free).toContainText("Free");
    if (isMobile(testInfo)) expect(await pageHeight(page), "Home at 390 stays short").toBeLessThan(1400);
    await noSidewaysScroll(page);
    await shot(page, "home-student");
  });

  await test.step("a class goes live: Join live moves to the top", async () => {
    const staff = await newUserContext(browser, test.info(), pageErrors, "host");
    await signIn(staff, manifest, "admin");
    const created = await apiAs(staff, "POST", "/api/realtime/sessions/", {
      data: {
        title: "OSINT Live: Sat batch",
        session_type: "meeting",
        linked_live_class_id: manifest.live_classes.meeting.id,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const session = (await created.json()).data;
    expect(session.status).toBe("live");

    await page.reload();
    const card = nextUp(page);
    await expect(card).toHaveAttribute("data-kind", "live_now");
    await expect(card.getByRole("heading", { name: "OSINT Live: Sat batch" })).toBeVisible();
    const join = card.getByRole("link", { name: "Join live" });
    await expectActionAboveFold(page, join);
    await expect(join).toHaveAttribute("href", `/join-live?session=${session.id}`);
    // The exam steps down to "Also this week".
    await expect(page.getByRole("link", { name: new RegExp(manifest.exam.title) })).toBeVisible();
    await shot(page, "home-live-now");
    await join.click();
    await expect(page).toHaveURL(new RegExp(`/join-live\\?session=${session.id}`));
    await staff.close();
  });
});

test("home: a user with no course is pointed at the catalogue (no countdown)", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  await signIn(context, manifest, "outsider");
  await page.goto("/console");
  const card = nextUp(page);
  await expect(card).toHaveAttribute("data-kind", "browse");
  await expect(card.getByRole("heading", { name: "You're not enrolled yet" })).toBeVisible();
  await expectActionAboveFold(page, card.getByRole("link", { name: "Browse courses" }));
  await expect(page.getByText(/Starts in/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your courses" })).toHaveCount(0);
  await noSidewaysScroll(page);
  await shot(page, "home-no-course");

  await page.goto("/reports");
  await expect(page.getByRole("heading", { level: 1, name: "Coursework" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse courses" })).toBeVisible();
  await shot(page, "coursework-week-no-course");
});

test("teach today: instructor sees the jobs with counts (Teaching on) and Home with it off", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  await signIn(context, manifest, "instructor");

  await test.step("Teaching off: Home is the Learn home", async () => {
    await setFeatures(control, { teaching: false });
    await page.goto("/console");
    await expect(nextUp(page)).toHaveAttribute("data-kind", "browse");
    await expectActionAboveFold(page, nextUp(page).getByRole("link", { name: "Browse courses" }));
    await shot(page, "home-instructor-teaching-off");
  });

  await test.step("Teaching on: Teach > Today", async () => {
    await setFeatures(control, { teaching: true });
    await page.goto("/console/teach");
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    for (const name of [/To grade/, /You host next/, /Recordings/, /Exams open/]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    // The seeded exam is open for the instructor's course.
    await expect(page.getByText(/1 exam open/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Open queue/ })).toHaveAttribute("href", "/console/teach/grading");
    await noSidewaysScroll(page);
    await shot(page, "teach-today");
  });
});

test("learn pages: coursework tabs, marks redirect, reduce motion, OSINT tools, player", async ({ page, context, control }, testInfo) => {
  const manifest = await control.reset({ freeze: SATURDAY_NOON });
  await page.clock.setFixedTime(new Date(SATURDAY_NOON));
  await signIn(context, manifest, "student1");

  await test.step("Coursework: This week · Grades · Exams; /reports/marks lands on Grades", async () => {
    await page.goto("/reports");
    const tabs = page.getByRole("navigation", { name: "Coursework" });
    await expect(tabs.getByRole("link", { name: "This week" })).toHaveAttribute("aria-current", "page");
    await shot(page, "coursework-week");
    await page.goto("/reports/marks");
    await expect(page).toHaveURL(/\/gradebook$/);
    await expect(tabs.getByRole("link", { name: "Grades" })).toHaveAttribute("aria-current", "page");
    await shot(page, "coursework-grades");
    await tabs.getByRole("link", { name: "Exams" }).click();
    await expect(page).toHaveURL(/\/coursework\/exams$/);
    await expect(page.getByRole("heading", { name: manifest.exam.title })).toBeVisible();
    await expect(page.getByRole("link", { name: /Start exam/ })).toHaveAttribute("target", "_blank");
    await noSidewaysScroll(page);
    await shot(page, "coursework-exams");
  });

  await test.step("My courses: one champagne action, no stat chips", async () => {
    await page.goto("/my-courses");
    await expect(page.getByRole("heading", { name: manifest.course.title })).toBeVisible();
    await expect(page.locator(".cds-stat-chip")).toHaveCount(0);
    await expect(page.locator(".cds-course-tile__primary--accent")).toHaveCount(1);
    await shot(page, "my-courses");
  });

  await test.step("Profile: Reduce motion sets data-motion on <html>", async () => {
    await page.goto("/profile");
    const toggle = page.getByRole("switch", { name: /Reduce motion/ });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await shot(page, "profile");
    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
    await toggle.click();
    await expect(page.locator("html")).not.toHaveAttribute("data-motion", "reduce");
  });

  await test.step("OSINT tools: folded categories keep the page short", async () => {
    await page.goto("/osint-tools");
    await expect(page.getByRole("heading", { level: 1, name: "OSINT tools" })).toBeVisible();
    if (isMobile(testInfo)) expect(await pageHeight(page), "OSINT tools at 390").toBeLessThan(3000);
    await shot(page, "osint-tools");
    const first = page.locator(".cds-osint-group__toggle").first();
    await first.click();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("searchbox").fill("spiderfoot");
    await expect(page.getByText("1 tool matching “spiderfoot”")).toBeVisible();
    await noSidewaysScroll(page);
  });

  await test.step("Player: no sideways scroll, every action at least 24 px", async () => {
    await page.goto(`/learn/${manifest.course.id}`);
    await expect(page.getByText(manifest.lectures[0].title).first()).toBeVisible();
    const actions = page.getByRole("group", { name: "Lesson actions" });
    await expect(actions.getByRole("button", { name: /Next lesson/ })).toBeVisible();
    await noSidewaysScroll(page);
    const small = await actions.locator("button, a").evaluateAll((nodes) =>
      nodes
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && (rect.width < 24 || rect.height < 24)).length
    );
    expect(small, "lesson action targets under 24 px").toBe(0);
    for (const button of await actions.locator("button").all()) {
      const box = await button.boundingBox();
      expect(box.x + box.width, "action inside the viewport").toBeLessThanOrEqual(page.viewportSize().width);
    }
    await shot(page, "player");
  });
});
