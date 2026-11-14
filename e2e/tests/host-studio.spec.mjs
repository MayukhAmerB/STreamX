// Host Studio class against the LiveKit stub (Phase 2): async Go Live answers
// 202 and the worker starts the egress; the host's heartbeat keeps it live;
// when the host's tab disappears (heartbeat expires, egress gone) viewers see
// "Host reconnecting…", the reconciler stops and auto-ends the class, the
// live.ended handler deletes the LiveKit room, and the recording is published.
// The host side is driven through the same API the studio uses (a browser
// camera cannot publish into a stub SFU); the viewer is a real browser.
import { apiAs, expect, newUserContext, signIn, test } from "./helpers.mjs";

const CLASS_START = "2026-11-21T19:00:00+05:30"; // Saturday 19:00 IST

test("host studio: 202 Go Live -> heartbeat -> host gone -> auto-end -> room deleted -> recording", async ({ page, context, control, browser, pageErrors }) => {
  const manifest = await control.reset({ freeze: CLASS_START });
  const session = manifest.sessions.studio;
  const hostContext = await newUserContext(browser, test.info(), pageErrors, "host");
  await signIn(hostContext, manifest, "admin");
  const host = (method, path, data) => apiAs(hostContext, method, `/api/realtime/sessions/${session.id}/${path}`, { data });

  await test.step("the host presses Go Live: 202 opens the class, the worker starts the egress", async () => {
    // The studio's order: publish into the room, Go Live, then join the broadcast.
    await control.livekit({ participants: { [session.room]: 1 } });
    const goLive = await host("POST", "go-live/", {});
    expect(goLive.status(), await goLive.text()).toBe(202);
    // Go Live opens the scheduled class by itself (no Join Broadcast needed).
    expect((await control.sessionState(session.id)).status).toBe("live");
    await control.tick(["jobs"]); // realtime.go_live outbox event -> StartParticipantEgress on the stub
    expect((await host("POST", "join/", { display_name: "Host", prefer_broadcast: true })).ok()).toBeTruthy();
    const status = await (await host("GET", "go-live/")).json();
    expect(JSON.stringify(status)).toMatch(/"live"/);
    const calls = (await control.livekit({})).calls;
    expect(calls.some((call) => /StartParticipantEgress|StartRoomCompositeEgress/.test(call))).toBeTruthy();
    const heartbeat = await host("POST", "stream/heartbeat/", { publishing: true, state: "publishing" });
    expect(heartbeat.ok(), await heartbeat.text()).toBeTruthy();
    await control.tick(["live.reconcile", "recorder"], { clock: { advance: 5 } });
    const state = await control.sessionState(session.id);
    expect(state.stream_status).toBe("live");
    expect(state.recordings.map((item) => item.state)).toContain("recording"); // no Start Recording button
  });

  await test.step("a student watches", async () => {
    await signIn(context, manifest, "student2");
    await page.goto(`/join-live?session=${session.id}`);
    const join = page.getByRole("button", { name: /^(Join|Join Broadcast|Join class|Watch)/i }).first();
    if (await join.isVisible().catch(() => false)) await join.click();
    await expect(page.getByRole("heading", { name: `Now playing: ${session.title}` })).toBeVisible();
    await control.tick(["recorder"], { clock: { advance: 5 } });
  });

  await test.step("the host's tab disappears: heartbeat expires and the egress ends", async () => {
    const egress = (await control.livekit({})).egresses.find((item) => item.kind === "stream");
    await control.expireHostHeartbeat(session.id); // Redis TTL (30 s) passing
    await control.livekit({ endEgress: egress.id }); // LiveKit drops the participant egress
    await control.tick(["live.reconcile"], { clock: { advance: 5 } });
    expect((await control.sessionState(session.id)).stream_status).toBe("interrupted");
    await expect(page.getByText(/host reconnecting/i).first()).toBeVisible({ timeout: 40_000 });
  });

  await test.step("host grace over -> stopped; abandoned -> ended; LiveKit room deleted", async () => {
    // REALTIME_HOST_GRACE_SECONDS=20, REALTIME_ABANDONED_END_MINUTES=2 in E2E.
    await control.tick(["live.reconcile"], { clock: { advance: 25 } });
    expect((await control.sessionState(session.id)).stream_status).toBe("stopped");
    await control.tick(["live.reconcile", "jobs"], { clock: { advance: 130 } });
    const ended = await control.sessionState(session.id);
    expect(ended.status).toBe("ended");
    expect(ended.end_reason).toBe("abandoned");
    const calls = (await control.livekit({})).calls;
    expect(calls).toContain("livekit.RoomService/DeleteRoom");
  });

  await test.step("the recording is published with no clicks", async () => {
    await control.tick(["recorder", "jobs", "recorder"], { clock: { advance: 5 } });
    const state = await control.sessionState(session.id);
    const recording = state.recordings[0];
    expect(recording.error).toBe("");
    expect(["processing", "published"]).toContain(recording.state);
    expect(state.lectures[0]?.is_published).toBe(true);
    await page.goto(`/learn/${state.lectures[0] ? manifest.course.id : 0}`);
    await expect(page.getByText("Class recordings").first()).toBeVisible();
  });

  await test.step("the host's studio link (Admin workspace) opens the ended class", async () => {
    // UI overhaul §4.3: /console/admin/classes/:id/studio (old: /broadcasting?session=:id).
    const hostPage = await hostContext.newPage();
    await hostPage.clock.setFixedTime(new Date(CLASS_START));
    await hostPage.goto(`/console/admin/classes/${session.id}/studio`);
    await expect(hostPage).toHaveURL(new RegExp(`/console/admin/classes/${session.id}/studio`));
    await expect(hostPage.getByText(session.title).first()).toBeVisible();
    // An ended class can never be started again from its studio (absent, or disabled with a reason).
    const goLive = hostPage.getByRole("button", { name: /^(Go live|Start live)$/i });
    if (await goLive.count()) await expect(goLive.first()).toBeDisabled();
  });

  await hostContext.close();
});

// Go Live must never lock the host out (review: async Go Live host lock-out).
// No worker drains the queued job here, as when the worker is down or
// backlogged: the poll reports it stalled and the studio's synchronous
// fallback (stream/start/) goes live; the late job then starts nothing.
// Cancel while starting stops the queued start; a start stuck past the start
// timeout fails on the poll and a fresh Go Live works.
test("host studio: Go Live with a stalled worker recovers, cancels and times out cleanly", async ({ control, browser, pageErrors }) => {
  const manifest = await control.reset({ freeze: CLASS_START });
  const session = manifest.sessions.studio;
  const hostContext = await newUserContext(browser, test.info(), pageErrors, "host");
  await signIn(hostContext, manifest, "admin");
  const host = (method, path, data) => apiAs(hostContext, method, `/api/realtime/sessions/${session.id}/${path}`, { data });
  const poll = async () => (await (await host("GET", "go-live/")).json()).data;
  const egressStarts = async () =>
    (await control.livekit({})).calls.filter((call) => /StartParticipantEgress|StartRoomCompositeEgress/.test(call)).length;
  await control.livekit({ participants: { [session.room]: 1 } });

  await test.step("the queued job is not picked up: the poll reports it stalled after 30 s", async () => {
    expect((await host("POST", "go-live/", {})).status()).toBe(202);
    const fresh = await poll();
    expect(fresh.state).toBe("starting");
    expect(fresh.stalled).toBe(false);
    // Pressing Go Live again while a fresh job is queued does not queue a second one.
    expect((await host("POST", "go-live/", {})).status()).toBe(202);
    await control.clock({ advance: 31 });
    const stalled = await poll();
    expect(stalled.state).toBe("starting");
    expect(stalled.stalled).toBe(true);
  });

  await test.step("the studio's synchronous fallback goes live; the late job starts nothing", async () => {
    const start = await host("POST", "stream/start/", {});
    expect(start.status(), await start.text()).toBe(200);
    expect((await poll()).state).toBe("live");
    await control.tick(["jobs"]);
    expect(await egressStarts()).toBe(1);
    expect((await control.sessionState(session.id)).stream_status).toBe("live");
  });

  await test.step("Cancel while starting stops the queued start", async () => {
    expect((await host("POST", "stream/stop/", {})).ok()).toBeTruthy();
    expect((await host("POST", "go-live/", {})).status()).toBe(202);
    const cancel = await host("POST", "stream/stop/", {});
    expect(cancel.ok(), await cancel.text()).toBeTruthy();
    await control.tick(["jobs"]);
    expect(await egressStarts()).toBe(1);
    expect((await poll()).state).toBe("stopped");
  });

  await test.step("a start stuck past the timeout fails on the poll; Go Live again works", async () => {
    expect((await host("POST", "go-live/", {})).status()).toBe(202);
    await control.clock({ advance: 181 }); // REALTIME_STREAM_STARTING_TIMEOUT_SECONDS (180)
    const failed = await poll();
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/took too long/i);
    expect((await host("POST", "go-live/", {})).status()).toBe(202);
    await control.tick(["jobs"]);
    expect((await poll()).state).toBe("live");
    expect(await egressStarts()).toBe(2);
  });

  await hostContext.close();
});
