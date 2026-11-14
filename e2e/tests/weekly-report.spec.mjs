// Weekly report journey (Phase 3 acceptance): a student in a self-service
// course reports on "Acme Pvt Ltd" with no admin setup that week, "acme" is a
// 409 duplicate with "Open existing", a second target is accepted, an
// infected file is blocked, a report sent after Sunday 23:59 IST is late,
// staff grade it and the student sees the marks.
import { apiAs, expect, newUserContext, signIn, test } from "./helpers.mjs";

const SUNDAY_BEFORE_DEADLINE = "2026-11-15T23:50:00+05:30";
const MONDAY_AFTER_DEADLINE = "2026-11-16T00:10:00+05:30";
// Draft evidence: uploaded Wednesday, submitted Saturday (74 h later, beyond
// the 48 h staged-upload TTL that used to delete it).
const WEDNESDAY_UPLOAD = "2026-11-11T10:00:00+05:30";
const SATURDAY_SUBMIT = "2026-11-14T12:00:00+05:30";

const pdf = (name, extra = "") => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.from(`%PDF-1.4\n% ${name} ${extra}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`),
});

const weeklyCard = (page) => page.locator("section.rpt-weekly").first();

const UPLOAD_URL = /\/api\/reports\/me\/targets\/\d+\/files\/$/;

/** Pick files and wait until every upload is accepted (202: queued for the virus scan). */
async function pickFiles(page, files) {
  const uploads = files.map(() => page.waitForResponse((r) => UPLOAD_URL.test(r.url()) && r.request().method() === "POST"));
  await weeklyCard(page).locator('input[type="file"]').setInputFiles(files);
  for (const upload of uploads) expect((await upload).status()).toBe(202);
}

async function myWeek(context) {
  const response = await apiAs(context, "GET", "/api/reports/me/week/");
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data.courses[0];
}

test("weekly report: self-service targets, duplicate, virus block, late, graded", async ({ page, context, control, browser, pageErrors }) => {
  const manifest = await control.reset({ freeze: SUNDAY_BEFORE_DEADLINE });
  await page.clock.setFixedTime(new Date(SUNDAY_BEFORE_DEADLINE));
  await signIn(context, manifest, "student1");
  const card = weeklyCard(page);

  await test.step("the week is computed on the server (no admin setup)", async () => {
    await page.goto("/reports");
    await expect(card.getByRole("heading", { name: "Submit this week's report" })).toBeVisible();
    await expect(card.getByText("Week of 9–15 Nov", { exact: true })).toBeVisible();
    await expect(card.getByText(/Due Sun 15 Nov, 11:59 pm IST/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Submit report" })).toBeDisabled();
    await expect(card.getByText("Type the name of the target you investigated.")).toBeVisible();
  });

  await test.step('"Acme Pvt Ltd": target created on first use, file scanned, submitted on time', async () => {
    await card.getByLabel("Target name").fill("Acme Pvt Ltd");
    const created = page.waitForResponse((r) => r.url().endsWith("/api/reports/me/targets/") && r.request().method() === "POST");
    await pickFiles(page, [pdf("acme-report.pdf")]); // 202: the virus scan runs in the worker
    expect((await created).status()).toBe(201);
    await expect(card.getByRole("heading", { name: "Your report: Acme Pvt Ltd" })).toBeVisible();
    await expect(card.getByText("Checking your files for viruses…")).toBeVisible();
    await control.tick(["jobs"]); // worker: async ClamAV scan against the clamd stub -> clean
    await expect(card.locator("li", { hasText: "acme-report.pdf" })).toContainText("Ready", { timeout: 20_000 });
    await card.getByRole("button", { name: "Submit report" }).click();
    await expect(card.getByText("Report submitted."), "the Undo confirmation after Submit").toBeVisible();
    await expect(card.getByRole("button", { name: "Undo" })).toBeVisible();
    const week = await myWeek(context);
    const acme = week.weeks.find((item) => item.which === "current").targets.find((item) => item.target_name === "Acme Pvt Ltd");
    expect(acme?.status).toBe("submitted");
    expect(acme?.is_late).toBeFalsy();
    await expect(card.getByRole("list", { name: /Your reports for Week of 9–15 Nov/ })).toContainText("Acme Pvt Ltd");
  });

  await test.step('"acme" the same week: 409 duplicate with "Open existing"', async () => {
    const duplicate = await apiAs(context, "POST", "/api/reports/me/targets/", {
      data: { course: manifest.course.id, target_name: "acme", week: "current" },
    });
    expect(duplicate.status()).toBe(409);
    const body = await duplicate.json();
    expect(JSON.stringify(body)).toContain("duplicate_target");
    expect(JSON.stringify(body)).toContain("Acme Pvt Ltd");

    await page.goto("/reports");
    await card.getByLabel("Target name").fill("acme");
    await expect(card.getByText("You already have a report for “Acme Pvt Ltd”."), '"Open existing" hint').toBeVisible();
    await card.getByRole("button", { name: "Open existing" }).click();
    await expect(card.getByRole("heading", { name: "Your report: Acme Pvt Ltd" })).toBeVisible();
  });

  await test.step("another domain warns (confirmable), two profiles on one platform are two targets", async () => {
    // Review finding: "acme.org" and facebook.com/<person> used to collide
    // with existing targets as a hard 409 duplicate_target.
    const post = (name, extra = {}) =>
      apiAs(context, "POST", "/api/reports/me/targets/", {
        data: { course: manifest.course.id, target_name: name, week: "current", ...extra },
      });
    const similar = await post("acme.org");
    expect(similar.status()).toBe(409);
    const similarBody = await similar.json();
    expect(similarBody.code).toBe("similar_target");
    expect(similarBody.errors.needs_confirmation).toBe(true);
    expect(similarBody.errors.suggestions.map((item) => item.target_name)).toContain("Acme Pvt Ltd");
    const created = [];
    for (const [name, extra] of [["acme.org", { confirm_different: true }], ["https://www.facebook.com/john/", {}], ["facebook.com/jane", {}]]) {
      const response = await post(name, extra);
      expect(response.status(), name).toBe(201);
      created.push((await response.json()).data.id);
    }
    const again = await post("https://m.facebook.com/John?ref=bookmarks");
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe("duplicate_target");

    await page.goto("/reports");
    await card.getByLabel("Target name").fill("acme.com");
    await expect(card.getByRole("button", { name: "Submit report" })).toBeVisible();
    await expect(card.getByText(/You already have a report for/)).toHaveCount(0);

    // Discard the drafts so the rest of the journey sees two targets.
    for (const id of created) expect((await apiAs(context, "DELETE", `/api/reports/me/targets/${id}/`)).ok()).toBeTruthy();
  });

  await test.step("a second target is accepted; an infected file is blocked", async () => {
    await page.goto("/reports");
    await card.getByLabel("Target name").fill("Globex Corporation");
    await pickFiles(page, [pdf("globex-evidence.pdf", "E2E-INFECTED")]);
    await expect(card.getByRole("heading", { name: "Your report: Globex Corporation" })).toBeVisible();
    await control.tick(["jobs"]);
    await expect(card.locator("li", { hasText: "globex-evidence.pdf" })).toContainText("Blocked", { timeout: 20_000 });
    await expect(card.getByText("Remove the file the virus scanner blocked.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Submit report" })).toBeDisabled();
    await card.getByRole("button", { name: "Remove globex-evidence.pdf" }).click();
    await expect(card.locator("li", { hasText: "globex-evidence.pdf" })).toHaveCount(0);
    await pickFiles(page, [pdf("globex-report.pdf")]);
    await control.tick(["jobs"]);
    await expect(card.locator("li", { hasText: "globex-report.pdf" })).toContainText("Ready", { timeout: 20_000 });
    const week = await myWeek(context);
    expect(week.weeks.find((item) => item.which === "current").targets.map((item) => item.target_name).sort()).toEqual([
      "Acme Pvt Ltd",
      "Globex Corporation",
    ]);
  });

  await test.step("Sunday 23:59 IST passes before Submit: the report is late", async () => {
    await control.clock({ freeze: MONDAY_AFTER_DEADLINE });
    await page.clock.setFixedTime(new Date(MONDAY_AFTER_DEADLINE));
    const submitted = page.waitForResponse((r) => /\/submit\/$/.test(r.url()));
    await card.getByRole("button", { name: "Submit report" }).click();
    expect((await submitted).ok(), "submit after the deadline (late window)").toBeTruthy();
    await expect(card.getByText("Report submitted.")).toBeVisible();
    const week = await myWeek(context);
    const previous = week.weeks.find((item) => item.which === "previous");
    expect(previous, JSON.stringify(week.weeks)).toBeTruthy();
    expect(previous.status).toBe("late");
    const globex = previous.targets.find((item) => item.target_name === "Globex Corporation");
    expect(globex?.status).toBe("submitted");
    expect(globex?.is_late, JSON.stringify(globex)).toBeTruthy();
    expect(previous.targets.find((item) => item.target_name === "Acme Pvt Ltd")?.is_late).toBeFalsy();
    await page.goto("/reports");
    await expect(card.getByRole("radiogroup", { name: "Which week is this report for?" }).or(card.getByText(/Last week \(late/))).toBeVisible();
  });

  await test.step("staff grade the late report; the student sees the marks", async () => {
    const staff = await newUserContext(browser, test.info(), pageErrors, "grader");
    await signIn(staff, manifest, "admin");
    const grader = await staff.newPage();
    await grader.clock.setFixedTime(new Date(MONDAY_AFTER_DEADLINE));
    await grader.goto(`/report-grading/queue?course=${manifest.course.id}`);
    // Grouped week -> target -> oldest; the late badge is on the Globex row.
    await expect(grader.getByText("Week of 9–15 Nov", { exact: true })).toBeVisible();
    await expect(grader.getByText("Globex Corporation (1)")).toBeVisible();
    await grader.getByText(/11 min late/).click();
    const form = grader.getByRole("region", { name: "Marks and feedback" }).or(grader.locator('section[aria-label="Marks and feedback"]'));
    await form.getByLabel(/^Marks \(out of 10\)/).fill("8");
    await form.getByLabel("Feedback for the student").fill("Good correlation of sources. Late by one day.");
    const graded = grader.waitForResponse((r) => /grade/.test(r.url()) && r.request().method() !== "GET");
    await form.getByRole("button", { name: /^(Save marks|Save & next)$/ }).first().click();
    expect((await graded).ok()).toBeTruthy();
    await staff.close();

    const week = await myWeek(context);
    const globex = week.weeks.find((item) => item.which === "previous").targets.find((item) => item.target_name === "Globex Corporation");
    expect(globex.status).toBe("graded");
    expect(globex.marks_visible).toBeTruthy();
    // 8/10 with one started day late at -10% of the maximum: 7.
    expect(Number(globex.final_marks)).toBe(7);
    // Marks visible "on grade": the report list, My marks and the gradebook.
    await page.goto("/reports");
    await card.getByText("Last week (late, -10%)").click();
    await expect(card.getByRole("list", { name: /Your reports for Week of 9–15 Nov/ }).getByRole("button", { name: /Globex Corporation/ })).toContainText(
      "Graded 7/10"
    );
    await page.goto("/reports/marks");
    await expect(page.getByText("7/10").first()).toBeVisible();
    await expect(page.getByText("Late", { exact: true }).first()).toBeVisible();
    await page.goto("/gradebook");
    await expect(page.getByRole("row", { name: /Week of 9–15 Nov reports.*7\/10/ })).toBeVisible();
  });
});

test("weekly report: draft evidence uploaded days earlier survives until Submit", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: WEDNESDAY_UPLOAD });
  await page.clock.setFixedTime(new Date(WEDNESDAY_UPLOAD));
  await signIn(context, manifest, "student1");
  const card = weeklyCard(page);
  const acmeDraft = async () => {
    const week = await myWeek(context);
    return week.weeks.find((item) => item.which === "current").targets.find((item) => item.target_name === "Acme Pvt Ltd");
  };

  await test.step("Wednesday: evidence uploaded and scanned, report left as a draft", async () => {
    await page.goto("/reports");
    await card.getByLabel("Target name").fill("Acme Pvt Ltd");
    await pickFiles(page, [pdf("acme-wednesday.pdf")]);
    await expect(card.getByRole("heading", { name: "Your report: Acme Pvt Ltd" })).toBeVisible();
    await control.tick(["jobs"]);
    await expect(card.locator("li", { hasText: "acme-wednesday.pdf" })).toContainText("Ready", { timeout: 20_000 });
    const draft = await acmeDraft();
    expect(draft?.status).toBe("not_submitted");
    expect(draft?.draft_file_count).toBe(1);
  });

  await test.step("Saturday (74 h later): housekeeping and another upload keep the draft's file", async () => {
    await control.clock({ freeze: SATURDAY_SUBMIT });
    await page.clock.setFixedTime(new Date(SATURDAY_SUBMIT));
    // The hourly prune and the weekly scheduler (draft cleanup) both run.
    const ticked = await control.tick(["reports.housekeeping", "reports.scheduler"]);
    for (const item of ticked.results) expect(item.result.drained.events, JSON.stringify(item)).toBeGreaterThanOrEqual(1);
    // Every self-service upload also prunes this student's stale staged files.
    await page.goto("/reports");
    await card.getByLabel("Target name").fill("Initech");
    await pickFiles(page, [pdf("initech-saturday.pdf")]);
    await expect(card.getByRole("heading", { name: "Your report: Initech" })).toBeVisible();
    await control.tick(["jobs"]);
    const draft = await acmeDraft();
    expect(draft?.status).toBe("not_submitted");
    expect(draft?.draft_file_count, "the Wednesday evidence is still attached").toBe(1);
  });

  await test.step("the student opens the draft and submits it on time with the Wednesday file", async () => {
    await page.goto("/reports");
    await card.getByRole("list", { name: /Your reports for Week of 9–15 Nov/ }).getByRole("button", { name: /Acme Pvt Ltd/ }).click();
    await expect(card.getByRole("heading", { name: "Your report: Acme Pvt Ltd" })).toBeVisible();
    await expect(card.locator("li", { hasText: "acme-wednesday.pdf" })).toContainText("Ready");
    const submitted = page.waitForResponse((r) => /\/submit\/$/.test(r.url()));
    await card.getByRole("button", { name: "Submit report" }).click();
    expect((await submitted).status()).toBe(201);
    await expect(card.getByText("Report submitted.")).toBeVisible();
    const acme = await acmeDraft();
    expect(acme?.status).toBe("submitted");
    expect(acme?.is_late).toBeFalsy();
    expect(acme?.file_count).toBe(1);
  });
});
