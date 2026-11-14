// Live class lifecycle (Phase 2 acceptance), OBS class against the Owncast
// stub: staff start the class, OBS "connects" (stub online), a student
// joins; OBS drops (stub offline) and viewers see "Host reconnecting…"; the
// reconciler stops and then auto-ends the abandoned class after the grace
// periods (shortened in E2E settings, crossed with the test clock); the
// stream recorder finalizes the take with the fake ffmpeg runner and the
// recording is published into the course with no clicks; the student sees it.
import { expect, newUserContext, signIn, test } from "./helpers.mjs";

const CLASS_START = "2026-11-20T19:00:00+05:30"; // Friday 19:00 IST

function at(base, seconds) {
  return new Date(new Date(base).getTime() + seconds * 1000).toISOString();
}

test("live class: OBS live -> host drops -> reconnecting -> auto-end -> recording published", async ({ page, context, control, browser, pageErrors }) => {
  const manifest = await control.reset({ freeze: CLASS_START });
  const session = manifest.sessions.obs;
  const staff = await newUserContext(browser, test.info(), pageErrors, "host");
  await signIn(staff, manifest, "admin");
  const host = await staff.newPage();

  const sessionCard = () =>
    // The nearest ancestor of the session title that holds its action buttons.
    host
      .getByText(session.title, { exact: true })
      .first()
      .locator("xpath=ancestor::*[.//button[normalize-space()='Open Host Studio']][1]");

  await test.step("staff open the OBS class in the Host Studio and start it", async () => {
    await host.goto("/broadcasting");
    await sessionCard().getByRole("button", { name: "Open Host Studio" }).click();
    const start = host.getByRole("button", { name: /^(Start Live|Resume OBS)$/ });
    await expect(start).toBeVisible();
    // The Start/Stop Recording buttons are gone: recording is automatic.
    await expect(host.getByRole("button", { name: /recording/i })).toHaveCount(0);
    const started = host.waitForResponse((r) => r.url().endsWith(`/sessions/${session.id}/stream/start/`));
    await start.click();
    const response = await started;
    expect(response.ok()).toBeTruthy();
    expect(response.request().timing().responseEnd, "Start Live answers quickly").toBeLessThan(5_000);
    // Start Live alone opens the class: students may join and wait for the feed.
    const opened = await control.sessionState(session.id);
    expect(opened.status).toBe("live");
    expect(opened.stream_status).toBe("starting");
  });

  await test.step("OBS connects: the class goes live; the recorder starts a take", async () => {
    await control.owncast({ online: true });
    await control.tick(["live.reconcile", "realtime.obs_stream_health", "recorder"], { clock: { advance: 10 } });
    // Start Live opens the class (scheduled -> live) without the host also
    // pressing Join Broadcast; the reconciler marks the stream live from the feed.
    const state = await control.sessionState(session.id);
    expect(state.status).toBe("live");
    expect(state.stream_status).toBe("live");
    expect(state.recordings.map((item) => item.state)).toEqual(["recording"]);
  });

  await test.step("a student joins and the player is live", async () => {
    await signIn(context, manifest, "student1");
    await page.goto(`/join-live?session=${session.id}`);
    await expect(page.getByText(session.title).first()).toBeVisible();
    // The ?session= deep link joins a live class by itself (no click: clicking
    // raced the auto-join and hit a detached, disabled Join button).
    await expect(page.locator("video").first()).toBeAttached({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Leave", exact: true })).toBeVisible();
    await control.tick(["recorder"], { clock: { advance: 10 } }); // the take keeps capturing
  });

  await test.step('OBS drops: viewers see "Host reconnecting…" within 5 s', async () => {
    const hostReconnecting = page.getByText(/host reconnecting/i).first();
    await expect(hostReconnecting).toBeHidden();
    const feedDropped = Date.now();
    await control.owncast({ online: false });
    await control.tick(["live.reconcile", "recorder"], { clock: { advance: 5 } });
    const serverMarked = Date.now();
    expect((await control.sessionState(session.id)).stream_status).toBe("interrupted");
    // The player reports the lost playlist / stall at once; the page then asks
    // the server immediately and polls every 2-3 s until it confirms, instead
    // of waiting for the 30 s live poll (E2E run-02 measured 31 s).
    await expect(hostReconnecting).toBeVisible({ timeout: 15_000 });
    const now = Date.now();
    const sinceServer = Math.round((now - serverMarked) / 100) / 10;
    const sinceDrop = Math.round((now - feedDropped) / 100) / 10;
    test.info().annotations.push({
      type: "metric",
      description: `"Host reconnecting" visible ${sinceServer} s after the reconciler marked the stream interrupted (${sinceDrop} s after the feed dropped)`,
    });
    expect(sinceServer, '"Host reconnecting" within 5 s of the server marking the stream interrupted').toBeLessThanOrEqual(5);
  });

  await test.step("grace over -> stopped; abandoned -> the class auto-ends", async () => {
    // The host is gone too: an open Host Studio tells the server the host is
    // present (an OBS break is never "abandoned"), so close it. Start Live no
    // longer needs Join Broadcast, so the studio would otherwise stay open.
    await host.close();
    await control.expireHostHeartbeat(session.id); // its Redis TTL (30 s, real time) passing
    // REALTIME_OWNCAST_OFFLINE_GRACE_SECONDS=20 and REALTIME_ABANDONED_END_MINUTES=2 in E2E.
    await control.tick(["live.reconcile"], { clock: { advance: 25 } });
    expect((await control.sessionState(session.id)).stream_status).toBe("stopped");
    await control.tick(["live.reconcile"], { clock: { advance: 130 } });
    const ended = await control.sessionState(session.id);
    expect(ended.status).toBe("ended");
    expect(ended.end_reason).toBe("abandoned");
    await expect(page.getByText(/(class|broadcast|session) (has )?ended|ended/i).first()).toBeVisible({ timeout: 20_000 });
  });

  await test.step("the recording is finalized and published with no clicks", async () => {
    await control.tick(["recorder", "jobs", "recorder"], { clock: { advance: 5 } });
    const state = await control.sessionState(session.id);
    const recording = state.recordings[0];
    expect(recording.error).toBe("");
    expect(["processing", "published"]).toContain(recording.state);
    expect(recording.lecture_id).toBeTruthy();
    expect(state.lectures[0].is_published).toBe(true);
    // The OBS class has no module: a "Class recordings" section is created and flagged for review.
    expect(state.lectures[0].module).toBe("Class recordings");
    expect(recording.needs_review).toBe(true);
    test.info().annotations.push({ type: "lecture", description: `${state.lectures[0].id}: ${state.lectures[0].title}` });
  });

  await test.step("the student finds the recording in the course player", async () => {
    const lecture = (await control.sessionState(session.id)).lectures[0];
    await page.goto(`/learn/${manifest.course.id}`);
    await expect(page.getByText("Class recordings").first()).toBeVisible();
    await page.getByText("Class recordings").first().click();
    await expect(page.getByText(lecture.title).first()).toBeVisible();
  });

  await staff.close();
});
