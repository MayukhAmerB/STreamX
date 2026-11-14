// Staff exam lifecycle in the Console (Phase 3): upload with a server dry run,
// readiness checklist keeps Publish disabled until complete, schedule, then
// the ctf.scheduler opens it at opens_at and closes it at closes_at with no
// SSH and no Django admin. The test clock makes those instants exact.
import { expect, signIn, test } from "./helpers.mjs";

const NOW = "2026-11-20T10:00:00+05:30"; // Friday 10:00 IST
const OPENS = "2026-11-20T18:00"; // datetime-local, IST
const CLOSES = "2026-11-20T20:00";

function examFile(slug) {
  const document = {
    schema_version: 1,
    exam: { slug, title: { en: "E2E Console exam" }, briefing: { en: ["Loaded from the Console."] }, rules: { en: ["Work alone."] } },
    questions: [
      {
        key: "console-q1",
        order: 1,
        category: "dorking",
        difficulty: "medium",
        points: 5,
        title: { en: "Find the file type" },
        prompt: { en: { task: "Which operator limits results to PDF files?" } },
        answers: ["filetype:pdf"],
        solution: "instructor-only, never loaded",
      },
    ],
  };
  return { name: `${slug}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(document, null, 2)) };
}

test("exam console: dry run, readiness gate, schedule, auto-open and auto-close", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: NOW });
  await page.clock.setFixedTime(new Date(NOW));
  await signIn(context, manifest, "admin");
  const slug = manifest.console_exam_slug;

  await test.step("upload: the server dry run shows counts only and saves nothing", async () => {
    await page.goto("/console/exams");
    await page.getByLabel("Exam file", { exact: true }).and(page.locator("input[type=file]")).setInputFiles(examFile(slug));
    await expect(page.getByRole("button", { name: "Load exam" })).toBeDisabled();
    await expect(page.getByText("Check the file before loading it.")).toBeVisible();
    await page.getByRole("button", { name: "Check file" }).click();
    await expect(page.getByText("Dry run passed. Nothing has been saved yet.")).toBeVisible();
    await expect(page.locator(".exm-preview")).not.toContainText("filetype:pdf"); // the key never leaves the server
    await expect(page.getByRole("link", { name: "E2E Console exam" })).toHaveCount(0);
    await page.getByRole("button", { name: "Load exam" }).click();
    // Loading opens the new exam's page.
    await expect(page).toHaveURL(new RegExp(`/console/exams/${slug}$`));
    await expect(page.getByRole("heading", { level: 1, name: "E2E Console exam" })).toBeVisible();
  });

  await test.step("readiness checklist keeps Publish disabled until window and batches are set", async () => {
    const publish = page.locator(".exm-publish").getByRole("button").first();
    await expect(publish).toBeDisabled();
    await expect(page.locator("#exm-publish-reason")).toContainText(/more\)|window|batch/i);
    await expect(page.getByText(/Readiness: [0-5] of 6/)).toBeVisible();

    await page.getByLabel("Opens (IST)").fill(OPENS);
    await page.getByLabel("Closes (IST)").fill(CLOSES);
    await page.getByLabel("Time limit (minutes, empty = until it closes)").fill("60");
    await page.locator("label.cds--checkbox-label", { hasText: manifest.course.title }).click(); // Carbon: the label takes the click
    await expect(page.getByLabel(new RegExp(manifest.course.title))).toBeChecked();
    await page.getByRole("button", { name: "Save window and batches" }).click();
    await expect(page.getByText("Readiness: 6 of 6")).toBeVisible();
    await expect(publish).toBeEnabled();
    await expect(publish).toHaveText("Schedule");
  });

  await test.step("schedule: it will publish itself at the opening time", async () => {
    await page.locator(".exm-publish").getByRole("button", { name: "Schedule" }).click();
    await expect(page.locator("#exm-publish-reason")).toContainText("It will publish itself at");
    await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
  });

  await test.step("ctf.scheduler opens the exam at opens_at", async () => {
    await control.tick(["ctf.scheduler"], { clock: { freeze: "2026-11-20T17:59:00+05:30" } });
    let state = await (await context.request.get(`/api/ctf-admin/exams/${slug}/`)).json();
    expect(JSON.stringify(state)).toContain('"state":"scheduled"');
    await control.tick(["ctf.scheduler"], { clock: { freeze: "2026-11-20T18:00:30+05:30" } });
    await page.clock.setFixedTime(new Date("2026-11-20T18:00:30+05:30"));
    await page.reload();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/open now/i).first()).toBeVisible();
    state = await (await context.request.get(`/api/ctf-admin/exams/${slug}/`)).json();
    expect(JSON.stringify(state)).toContain('"state":"published"');
  });

  await test.step("ctf.scheduler closes it at closes_at", async () => {
    await control.tick(["ctf.scheduler"], { clock: { freeze: "2026-11-20T20:00:30+05:30" } });
    await page.clock.setFixedTime(new Date("2026-11-20T20:00:30+05:30"));
    await page.reload();
    await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
    const state = await (await context.request.get(`/api/ctf-admin/exams/${slug}/`)).json();
    expect(JSON.stringify(state)).toContain('"state":"closed"');
  });
});
