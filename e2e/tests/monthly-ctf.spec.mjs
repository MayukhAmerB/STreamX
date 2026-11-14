// Monthly OSINT CTF (WS-MONTHLY-CTF): free for every registered student, a
// season scheduled in the back office, opened and closed by the scheduler,
// ranked by time + penalties, finalised automatically with rewards (Golden
// Aura, trophies, Finalist certificate, XP). Boards show handles, never real
// names. With the `monthly_ctf` switch off the page stays browsable and the
// play action is disabled with its reason; the API answers 403 feature_disabled.
import fs from "node:fs";
import path from "node:path";

import { apiAs, expect, isMobile, newUserContext, setFeatures, signIn, signInToBackOffice, test } from "./helpers.mjs";

const SHOTS = process.env.E2E_SHOTS_DIR || "";
// 11:30 IST on 20 Nov 2026; the season opens 11:40 and closes 14:00 IST the same day.
const START = "2026-11-20T06:00:00Z";
const ANSWER = "Harbour 17";

async function shot(page, testInfo, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const width = page.viewportSize()?.width || (isMobile(testInfo) ? 390 : 1440);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true, animations: "disabled" });
}

async function createAndScheduleSeason(admin) {
  await admin.goto("/admin/ctf/ctfseason/add/");
  await admin.locator("#id_slug").fill("2026-11");
  await admin.locator("#id_month").fill("2026-11-01");
  await admin.locator("#id_title").fill("The Harbour Photograph");
  await admin.locator("#id_tagline").fill("Find the berth in a public photo.");
  await admin.locator("#id_brief").fill("A ferry company posted a photo of a moored ship.\n\nWork out which numbered berth it is tied to.");
  await admin.locator("#id_question").fill("Which berth is the ship moored at?");
  await admin.locator("#id_flag_format").fill("Harbour NN");
  await admin.locator("#id_accepted_answers").fill(ANSWER);
  await admin.locator("#id_opens_at_0").fill("2026-11-20");
  await admin.locator("#id_opens_at_1").fill("11:40:00");
  await admin.locator("#id_closes_at_0").fill("2026-11-20");
  await admin.locator("#id_closes_at_1").fill("14:00:00");
  await admin.locator('input[name="_save"]').click();
  await expect(admin).toHaveURL(/\/admin\/ctf\/ctfseason\/$/);
  await expect(admin.getByText("The Harbour Photograph").first()).toBeVisible();
  await admin.locator('input[name="_selected_action"]').first().check();
  await admin.locator('select[name="action"]').selectOption("schedule_selected");
  await admin.locator('button[name="index"], input[name="index"]').first().click();
  await expect(admin.getByText("1 season(s) scheduled.")).toBeVisible();
}

test("monthly ctf: scheduled, played, ranked, finalised with rewards; switch off disables, never hides", async ({ page, control, browser, pageErrors }, testInfo) => {
  test.setTimeout(180_000);
  const manifest = await control.reset({ freeze: START });
  await setFeatures(control, { monthly_ctf: true });

  // Before any season: the public page is there, the action is disabled with a reason.
  await page.goto("/monthly-ctf");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Solve the");
  await expect(page.getByRole("button", { name: /Play this month's case/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("The next case is being prepared.")).toBeVisible();

  // Admin creates and schedules November's season in the back office.
  const backOffice = await newUserContext(browser, testInfo, pageErrors, "admin");
  const admin = await backOffice.newPage();
  await signInToBackOffice(admin, manifest, "admin");
  await createAndScheduleSeason(admin);

  // Not open yet: the scheduler leaves it alone until 11:40 IST.
  await control.tick(["ctf.seasons"]);
  let current = await (await page.request.get("/api/ctf/seasons/current/")).json();
  expect(current.data.season.phase).toBe("upcoming");
  expect(current.data.season.brief).toBeNull();

  // 11:45 IST: the scheduler opens it.
  await control.clock({ advance: 15 * 60 });
  await control.tick(["ctf.seasons"]);
  current = await (await page.request.get("/api/ctf/seasons/current/")).json();
  expect(current.data.season.phase).toBe("open");

  // Student 1 plays in the Console: one wrong answer, then the right one.
  const studentContext = await newUserContext(browser, testInfo, pageErrors, "student1");
  const student = await studentContext.newPage();
  await signIn(studentContext, manifest, "student1");
  await student.goto("/monthly-ctf/play");
  await expect(student.getByText("Which berth is the ship moored at?")).toBeVisible();
  await shot(student, testInfo, "play-case");
  const field = student.getByLabel("Your answer");
  await field.fill("Harbour 9");
  await student.getByRole("button", { name: /Submit answer/ }).click();
  await expect(student.getByRole("status").filter({ hasText: "Not correct" })).toBeVisible();
  await control.clock({ advance: 5 * 60 });
  await field.fill("  harbour   17 ");
  await student.getByRole("button", { name: /Submit answer/ }).click();
  await expect(student.getByRole("status").filter({ hasText: "Correct. Your time is on the board." })).toBeVisible();
  await expect(student.getByRole("button", { name: /Submit answer/ })).toHaveAttribute("aria-disabled", "true");

  // Student 2 solves later through the API (clean, but 30 minutes slower).
  const second = await newUserContext(browser, testInfo, pageErrors, "student2");
  await signIn(second, manifest, "student2");
  await control.clock({ advance: 30 * 60 });
  const solved = await apiAs(second, "POST", "/api/ctf/seasons/2026-11/submit/", { data: { answer: ANSWER } });
  expect(solved.status()).toBe(200);
  expect((await solved.json()).data.rank).toBe(2);

  // Board: student1 first (20 min incl. the 10 min penalty) and First Blood; handles only.
  await student.getByRole("tab", { name: "Leaderboard" }).click();
  const rows = student.locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("First Blood");
  await expect(rows.first()).toContainText("You");
  const board = await (await page.request.get("/api/ctf/seasons/2026-11/leaderboard/")).json();
  expect(JSON.stringify(board)).not.toContain(manifest.users.student1.email);
  expect(JSON.stringify(board)).not.toContain("Sana");
  await shot(student, testInfo, "play-board");

  // Public page with the live board (visitor).
  await page.goto("/monthly-ctf");
  await expect(page.getByRole("link", { name: "Sign in to play" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await shot(page, testInfo, "public-open");

  // 14:05 IST: the scheduler closes and finalises; XP goes through the outbox.
  await control.clock({ freeze: "2026-11-20T08:35:00Z" });
  await control.tick(["ctf.seasons", "jobs"]);
  current = await (await page.request.get("/api/ctf/seasons/current/")).json();
  expect(current.data.season.phase).toBe("results");

  // The admin sees the final results and the granted rewards (audit included).
  await admin.goto("/admin/ctf/ctfseason/");
  await admin.getByRole("link", { name: "Preview" }).first().click();
  await expect(admin.getByText("Golden Aura · November 2026").first()).toBeVisible();

  // Student 1: trophies, certificate, and the Golden Aura on the shell avatar.
  await student.goto("/monthly-ctf/play");
  await student.getByRole("tab", { name: "My trophies" }).click();
  await expect(student.getByText("Season Champion · November 2026")).toBeVisible();
  await expect(student.getByText("Gold trophy · November 2026")).toBeVisible();
  await expect(student.locator('[data-cosmetic="aura"]').first()).toBeVisible();
  await shot(student, testInfo, "play-trophies");
  const certificateLink = student.getByRole("link", { name: /View and share/ });
  const href = await certificateLink.getAttribute("href");
  expect(href).toMatch(/^\/monthly-ctf\/certificates\/[\w-]+$/);

  // Anyone can verify the certificate; the Hall of Fame lists the champion's handle.
  await page.goto(href);
  await expect(page.getByText("Verified")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Certificate of Finalist" })).toBeVisible();
  await shot(page, testInfo, "certificate");
  await page.goto("/monthly-ctf/hall-of-fame");
  await expect(page.getByText("Season Champion").first()).toBeVisible();
  await expect(page.getByText("The Harbour Photograph")).toBeVisible();
  await shot(page, testInfo, "hall-of-fame");

  // Switched off: still browsable, the action is disabled with the reason; the API refuses.
  await setFeatures(control, { monthly_ctf: false });
  await page.goto("/monthly-ctf");
  await expect(page.getByRole("button", { name: /Play this month's case/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(/The Monthly CTF is not open yet/).first()).toBeVisible();
  await shot(page, testInfo, "public-off");
  const refused = await apiAs(second, "POST", "/api/ctf/seasons/2026-11/submit/", { data: { answer: ANSWER } });
  expect(refused.status()).toBe(403);
  expect(JSON.stringify(await refused.json())).toContain("feature_disabled");

  await backOffice.close();
  await studentContext.close();
  await second.close();
});
