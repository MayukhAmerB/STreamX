// Student identity pattern (owner rule, workstream identity-exam): roll number,
// real name, handle, stats lead the report submission screen, the Console exam
// screen and staff result tables; the block is auto-filled and read-only.
// Screens are captured at the project's width (390 / 1440) for design review
// when IDENTITY_SHOTS_DIR is set.
import path from "node:path";
import { apiAs, expect, LABS, newUserContext, signIn, test } from "./helpers.mjs";

const roll = (id) => `AL-SYD-${String(id).padStart(5, "0")}`;

async function shot(page, name) {
  const dir = process.env.IDENTITY_SHOTS_DIR;
  if (!dir) return;
  const width = page.viewportSize()?.width || 0;
  await page.screenshot({ path: path.join(dir, `${name}-${width}.png`), fullPage: false });
}

test("identity: the student block leads reports, exams and staff results", async ({ page, context, manifest, browser, pageErrors }) => {
  const student = manifest.users.student1;
  await signIn(context, manifest, "student1");

  await test.step("the API answers in the owner's order", async () => {
    const response = await apiAs(context, "GET", "/api/me/identity/");
    expect(response.ok()).toBeTruthy();
    const data = (await response.json()).data;
    expect(Object.keys(data).slice(0, 4)).toEqual(["roll_number", "real_name", "handle", "handle_most_recent"]);
    expect(data.roll_number).toBe(roll(student.id));
    expect(data.real_name).toBe(student.name);
  });

  await test.step("report submission screen: identity first, read-only", async () => {
    await page.goto("/reports");
    const block = page.getByTestId("student-identity");
    await expect(block).toBeVisible();
    await expect(block).toContainText(roll(student.id));
    await expect(block).toContainText(student.name);
    await expect(block).toContainText("Auto-filled · read-only");
    await expect(block.locator("input, textarea, select")).toHaveCount(0);
    const labels = await block.locator("dt").allInnerTexts();
    expect(labels.slice(0, 3).map((text) => text.toLowerCase())).toEqual(["roll number", "real name", "handle"]);
    // The block sits above the weekly report card.
    const blockBox = await block.boundingBox();
    const card = await page.locator("section.rpt-weekly").first().boundingBox();
    if (card) expect(blockBox.y).toBeLessThan(card.y);
    await shot(page, "reports");
  });

  await test.step("Console exam screen: the candidate block comes first", async () => {
    await page.goto("/coursework/exams");
    const block = page.getByTestId("student-identity");
    await expect(block).toBeVisible();
    await expect(block).toContainText("Exam candidate");
    await expect(block).toContainText(roll(student.id));
    await shot(page, "coursework-exams");
  });

  await test.step("staff results: roll number · real name · handle lead each row", async () => {
    const start = await apiAs(context, "POST", `/api/ctf/exams/${manifest.exam.slug}/start/`, { data: {} });
    expect(start.status()).toBeLessThan(300);
    const staff = await newUserContext(browser, test.info(), pageErrors, "staff");
    await signIn(staff, manifest, "admin");
    const console_ = await staff.newPage();
    await console_.goto(`/console/admin/exams/${manifest.exam.slug}`);
    await expect(console_.getByRole("columnheader", { name: /Student \(roll number · real name · handle\)/ })).toBeVisible();
    const row = console_.getByRole("link", { name: new RegExp(`^${roll(student.id)} · ${student.name} · `) });
    await expect(row).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await console_.evaluate(() => window.scrollBy(0, 200));
    await shot(console_, "staff-exam-results");
    const csv = await apiAs(staff, "GET", `/api/ctf-admin/exams/${manifest.exam.slug}/results.csv`);
    expect(csv.ok()).toBeTruthy();
    const header = (await csv.text()).replace(/^﻿/, "").split(/\r?\n/)[0];
    expect(header.startsWith("Roll number,Real name,Handle,Handle (most recent),XP,Rank,Attendance %")).toBeTruthy();
    await staff.close();
  });

  await test.step("labs Examination tab: the paper opens with the candidate block", async () => {
    await page.goto(`${LABS}/#exam`);
    await page.locator(`button[data-action="open"][data-slug="${manifest.exam.slug}"]`).click();
    const candidate = page.getByTestId("exam-identity");
    await expect(candidate).toBeVisible();
    await expect(candidate).toContainText(roll(student.id));
    await expect(candidate).toContainText(student.name);
    await expect(candidate).toContainText("HANDLE AT START");
    const html = await page.locator("#exam-view").innerHTML();
    expect(html.indexOf("exam-identity")).toBeLessThan(html.indexOf("exam-questions"));
    await candidate.scrollIntoViewIfNeeded();
    await shot(page, "labs-exam-paper");
  });
});
