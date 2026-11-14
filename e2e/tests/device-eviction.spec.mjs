// Device eviction during a class (Phase 2, D5): a student watching a live
// class signs in on more devices than allowed; the oldest device is evicted,
// but because it is in a class it keeps playing with a banner (no logout, no
// modal), keeps working through a token refresh, may use nothing but that
// class, and is signed out with a clear message once the class ends.
import { apiAs, expect, newUserContext, signIn, test } from "./helpers.mjs";

test("device eviction mid-class shows a banner and the class keeps playing", async ({ page, context, control, browser, manifest, pageErrors }) => {
  const session = manifest.sessions.obs;
  const banner = page.getByTestId("live-eviction-banner");
  const nowPlaying = page.getByRole("heading", { name: `Now playing: ${session.title}` });
  const noModal = async () => {
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  };

  await test.step("the class is live (host joined, OBS online)", async () => {
    const staff = await newUserContext(browser, test.info(), pageErrors, "host");
    await signIn(staff, manifest, "admin");
    const join = await staff.request.post(`/api/realtime/sessions/${session.id}/join/`, {
      headers: { "X-CSRFToken": (await staff.cookies()).find((c) => c.name === "csrftoken")?.value || "", Referer: `${test.info().project.use.baseURL}/` },
      data: { display_name: "Host", prefer_broadcast: true },
    });
    expect(join.ok(), await join.text()).toBeTruthy();
    await control.owncast({ online: true });
    await control.tick(["live.reconcile"]);
    expect((await control.sessionState(session.id)).stream_status).toBe("live");
    await staff.close();
  });

  await test.step("the student watches on device A", async () => {
    await signIn(context, manifest, "student1");
    await page.goto(`/join-live?session=${session.id}`);
    const join = page.getByRole("button", { name: /^(Join|Join Broadcast|Join class|Watch)/i }).first();
    if (await join.isVisible().catch(() => false)) await join.click();
    await expect(nowPlaying).toBeVisible();
  });

  await test.step("signing in on two more devices evicts device A", async () => {
    for (const label of ["device B", "device C"]) {
      const device = await newUserContext(browser, test.info(), pageErrors, label);
      await signIn(device, manifest, "student1");
      await device.close();
    }
  });

  await test.step("device A shows the banner and keeps the class", async () => {
    // Device A notices on its next API call (session poll, at most 30 s).
    await expect(banner).toBeVisible({ timeout: 45_000 });
    await expect(banner).toContainText("Signed in on another device.");
    await expect(banner).toContainText("This class will keep playing here until it ends.");
    await expect(banner).toContainText("After that, this device will be signed out.");
    await expect(page).toHaveURL(/\/join-live/);
    await expect(nowPlaying).toBeVisible();
    await expect(page.locator("video").first()).toBeAttached();
    await noModal(); // no blocking modal while the class plays
    await expect(banner.getByRole("button", { name: "Use this device instead" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  await test.step("device A keeps the class through a token refresh", async () => {
    // Expire device A's access token: its next class request must refresh,
    // and the server keeps rotating its tokens while the class is live.
    const refreshed = page.waitForResponse(
      (response) => response.url().includes("/api/auth/refresh/") && response.request().method() === "POST",
      { timeout: 45_000 }
    );
    await context.clearCookies({ name: "access_token" });
    const refresh = await refreshed;
    expect(refresh.status(), await refresh.text()).toBe(200);
    expect(refresh.headers()["x-session-state"]).toBe("live-grace");
    await expect
      .poll(async () => (await context.cookies()).some((cookie) => cookie.name === "access_token"))
      .toBe(true);

    await expect(banner).toBeVisible();
    await expect(page).toHaveURL(/\/join-live/);
    await expect(nowPlaying).toBeVisible();
    await expect(page.locator("video").first()).toBeAttached();
    await noModal();
  });

  await test.step("device A may use its class and nothing else", async () => {
    const classDetail = await apiAs(context, "GET", `/api/realtime/sessions/${session.id}/`);
    expect(classDetail.status(), await classDetail.text()).toBe(200);
    expect(classDetail.headers()["x-session-state"]).toBe("live-grace");
    const streamAccess = await apiAs(context, "POST", `/api/realtime/sessions/${session.id}/broadcast-stream/launch/`);
    expect(streamAccess.status(), await streamAccess.text()).toBe(200);
    const profile = await apiAs(context, "GET", "/api/auth/profile/");
    expect(profile.status()).toBe(401);
    expect(profile.headers()["x-session-state"]).toBe("live-grace");
  });

  await test.step("the class ends: device A is signed out with a clear message", async () => {
    const staff = await newUserContext(browser, test.info(), pageErrors, "host");
    await signIn(staff, manifest, "admin");
    const end = await apiAs(staff, "POST", `/api/realtime/sessions/${session.id}/end/`);
    expect(end.ok(), await end.text()).toBeTruthy();
    await staff.close();

    // Device A learns on its next poll (at most 30 s) and its refresh is refused.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText("Your class has ended");
    await expect(dialog).toContainText("signed out when the class ended");
    await expect(banner).toHaveCount(0);
    const me = await context.request.get("/api/auth/user/");
    expect(me.status()).toBe(401);

    await dialog.getByRole("button", { name: "Sign in again" }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});
