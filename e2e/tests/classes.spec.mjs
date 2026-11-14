// Classes (UI overhaul WS-D1): the old Meeting/Broadcasting pages open the
// merged Classes list; each class row has ONE primary action; Stop and
// Delete live in the overflow menu and only act after a confirmation that
// names the class; "Host a class" creates a class and opens its studio.
import { expect, signIn, test } from "./helpers.mjs";

const CLASS_START = "2026-11-20T19:00:00+05:30";

function row(page, title) {
  return page.locator("li.cls-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

async function openOverflow(page, title) {
  await row(page, title).getByRole("button", { name: `More actions for ${title}` }).click();
}

test("classes: old URLs land on Classes; Stop and Delete ask first and name the class", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: CLASS_START });
  const obs = manifest.sessions.obs;
  const meeting = manifest.sessions.meeting;
  await signIn(context, manifest, "admin");

  await test.step("/broadcasting and /meeting open the merged Classes page", async () => {
    await page.goto("/broadcasting");
    await expect(page).toHaveURL(/\/console\/admin\/classes\?mode=broadcast$/);
    await expect(page.getByRole("heading", { name: "Classes", exact: true })).toBeVisible();
    await expect(row(page, obs.title)).toBeVisible();
    await page.goto("/meeting");
    await expect(page).toHaveURL(/\/console\/admin\/classes\?mode=meeting$/);
    await expect(row(page, meeting.title)).toBeVisible();
    await expect(row(page, obs.title)).toHaveCount(0);
  });

  await test.step("one primary action per row; no danger button outside the overflow", async () => {
    await page.goto("/console/admin/classes");
    const obsRow = row(page, obs.title);
    await expect(obsRow.getByRole("button", { name: "Open Host Studio" })).toHaveCount(1);
    await expect(obsRow.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Delete|Stop)/ })).toHaveCount(0);
  });

  await test.step("Stop broadcast: the dialog names the class; Cancel sends nothing", async () => {
    let stops = 0;
    page.on("request", (request) => {
      if (request.url().endsWith(`/sessions/${obs.id}/stream/stop/`)) stops += 1;
    });
    await openOverflow(page, obs.title);
    await page.getByRole("menuitem", { name: "Stop broadcast" }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: `Stop the broadcast of “${obs.title}”?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(stops).toBe(0);
  });

  await test.step("Delete class: Cancel keeps it; confirming ends it and removes the row", async () => {
    await openOverflow(page, meeting.title);
    await page.getByRole("menuitem", { name: "Delete class" }).click();
    let dialog = page.getByRole("dialog").filter({ hasText: `Delete “${meeting.title}”?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await control.sessionState(meeting.id)).status).not.toBe("ended");

    await openOverflow(page, meeting.title);
    await page.getByRole("menuitem", { name: "Delete class" }).click();
    dialog = page.getByRole("dialog").filter({ hasText: `Delete “${meeting.title}”?` });
    const ended = page.waitForResponse((r) => r.url().endsWith(`/sessions/${meeting.id}/end/`));
    await dialog.getByRole("button", { name: "Delete class" }).click();
    expect((await ended).ok()).toBeTruthy();
    await expect(row(page, meeting.title)).toHaveCount(0);
    expect((await control.sessionState(meeting.id)).status).toBe("ended");
  });
});

test("classes: Host a class (OBS broadcast) opens its studio with the OBS key and Start Live", async ({ page, context, control }) => {
  const manifest = await control.reset({ freeze: CLASS_START });
  await signIn(context, manifest, "admin");
  await page.goto("/console/admin/classes");
  await page.getByRole("button", { name: "Host a class" }).click();
  const panel = page.getByRole("dialog", { name: "Host a class" });
  await expect(panel).toBeVisible();
  await panel.getByText("Broadcast", { exact: true }).click();
  await panel.getByText("OBS", { exact: true }).click();
  await panel.getByLabel("Live class").selectOption({ index: 1 });
  await panel.getByLabel("Class title").fill("E2E hosted from Classes");
  // The suggested rtmp://localhost server is not a public URL (the server refuses it); leave it empty.
  await panel.getByLabel("OBS server URL").fill("");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/realtime/sessions/") && r.request().method() === "POST");
  await panel.getByRole("button", { name: "Create class" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(/\/console\/admin\/classes\/\d+\/studio$/);
  await expect(page.getByRole("heading", { name: "E2E hosted from Classes", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Start Live|Resume OBS)$/ })).toBeVisible();
  await expect(page.getByText("Stream key", { exact: true })).toBeVisible();
  // Recording is automatic: no recording buttons in the studio.
  await expect(page.getByRole("button", { name: /recording/i })).toHaveCount(0);
});
