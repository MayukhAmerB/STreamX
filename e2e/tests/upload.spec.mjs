// Resumable class recording upload (owner: "better copy wins"). The OBS class
// is recorded by the server (auto-recording lecture). Staff then upload the
// laptop's OBS file (~200 MB, 7 chunks of 32 MiB) in Console -> Upload
// recording: the connection drops mid-upload (the page retries), the page is
// refreshed, the same file is picked again and only the missing chunks are
// sent; the worker assembles it and the file REPLACES the auto-recording's
// video in the same lecture. A personal upload token (desktop uploader) then
// uploads to a class without a recording: the lecture is CREATED and
// published; revoking the token locks it out.
import fs from "node:fs";
import path from "node:path";

import { apiAs, expect, newUserContext, signIn, test, WEB } from "./helpers.mjs";

const CLASS_START = "2026-11-20T19:00:00+05:30"; // Friday 19:00 IST
const MIB = 1024 * 1024;
const FILE_BYTES = 200 * MIB; // 6 x 32 MiB + 8 MiB
const MKV_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
const CHUNK_URL = /\/api\/recording-uploads\/[0-9a-f-]{36}\/chunks\/\d+\/$/;

/** A synthetic OBS MKV of FILE_BYTES (Matroska signature + deterministic filler), written in 8 MiB blocks. */
function writeSyntheticRecording(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    const block = Buffer.alloc(8 * MIB);
    for (let offset = 0; offset < FILE_BYTES; offset += block.length) {
      for (let index = 0; index < block.length; index += 4096) block.writeUInt32LE((offset + index) >>> 0, index);
      if (offset === 0) MKV_MAGIC.copy(block, 0);
      fs.writeSync(fd, block, 0, Math.min(block.length, FILE_BYTES - offset));
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function json(response) {
  const text = await response.text();
  expect(response.ok(), text.slice(0, 400)).toBeTruthy();
  return JSON.parse(text).data;
}

test("recording upload: drop + refresh + resume replaces the auto-recording; token upload creates the lecture", async ({
  page,
  context,
  control,
  browser,
  pageErrors,
}, testInfo) => {
  test.setTimeout(300_000);
  const manifest = await control.reset({ freeze: CLASS_START });
  const obs = manifest.sessions.obs;
  const studio = manifest.sessions.studio;
  const recordingFile = path.join(testInfo.outputPath("upload"), "2026-11-20 19-00-01.mkv");
  writeSyntheticRecording(recordingFile);
  await signIn(context, manifest, "admin");

  let autoLecture;
  await test.step("the server auto-records the OBS class and publishes the lecture", async () => {
    expect((await apiAs(context, "POST", `/api/realtime/sessions/${obs.id}/stream/start/`)).ok()).toBeTruthy();
    await control.owncast({ online: true });
    await control.tick(["live.reconcile", "realtime.obs_stream_health", "recorder"], { clock: { advance: 10 } });
    await control.tick(["recorder"], { clock: { advance: 30 } });
    expect((await control.sessionState(obs.id)).recordings.map((item) => item.state)).toEqual(["recording"]);
    await control.owncast({ online: false });
    const ended = await apiAs(context, "POST", `/api/realtime/sessions/${obs.id}/end/`);
    expect(ended.ok(), await ended.text()).toBeTruthy();
    await control.tick(["recorder", "jobs", "recorder", "jobs"], { clock: { advance: 5 } });
    const state = await control.sessionState(obs.id);
    expect(state.status).toBe("ended");
    expect(state.recordings[0].source).toBe("server");
    expect(state.recordings[0].lecture_id).toBeTruthy();
    autoLecture = state.lectures[0];
    expect(autoLecture.is_published).toBe(true);
  });

  const classSelect = () => page.getByLabel("Class", { exact: true });
  const fileInput = () => page.getByLabel("Recording file");

  let uploadId;
  await test.step("upload starts; the connection drops after 2 chunks and the page keeps retrying", async () => {
    await page.goto("/console/recordings/upload");
    await expect(page.getByRole("heading", { name: "Upload class recording" })).toBeVisible();
    await classSelect().selectOption(String(obs.id));
    await expect(page.getByText(/Replaces the video of/)).toBeVisible();
    await fileInput().setInputFiles(recordingFile);
    await expect(page.getByText("200 MB")).toBeVisible();

    let allowed = 2;
    let dropped = 0;
    await page.route(CHUNK_URL, async (route) => {
      if (allowed > 0) {
        allowed -= 1;
        return route.continue();
      }
      dropped += 1;
      return route.abort("connectionreset");
    });
    const created = page.waitForResponse((r) => r.url().endsWith("/api/recording-uploads/") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status()).toBe(201);
    uploadId = (await createdResponse.json()).data.id;
    await expect(page.getByText("Connection lost", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await json(await apiAs(context, "GET", `/api/recording-uploads/${uploadId}/`))).received_count, {
      timeout: 60_000,
    }).toBe(2);
    expect(dropped).toBeGreaterThan(0);
  });

  await test.step("after a refresh the same file resumes: only the 5 missing chunks are sent", async () => {
    // Still offline while the tab reloads; the network is back afterwards.
    await page.reload();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await expect(page.getByText("Unfinished upload: 2026-11-20 19-00-01.mkv")).toBeVisible();
    await expect(page.getByText(/2 of 7 parts are already on the server/)).toBeVisible();
    await expect(classSelect()).toHaveValue(String(obs.id));
    const sent = [];
    page.on("request", (request) => {
      if (CHUNK_URL.test(request.url())) sent.push(Number(request.url().split("/chunks/")[1].replace("/", "")));
    });
    await fileInput().setInputFiles(recordingFile);
    const completed = page.waitForResponse((r) => r.url().endsWith(`/api/recording-uploads/${uploadId}/complete/`), { timeout: 120_000 });
    await page.getByRole("button", { name: "Resume upload" }).click();
    await expect(page.getByText("Resumed: 64.0 MB were already on the server.")).toBeVisible();
    expect((await completed).status()).toBe(202);
    expect(sent.length).toBe(5);
    await expect(page.getByText("Upload complete – processing on the server")).toBeVisible();
  });

  await test.step("the worker assembles it and the better copy replaces the auto-recording", async () => {
    await control.tick(["jobs"]);
    await expect(page.getByText("Recording published", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: "Open the lecture" })).toBeVisible();
    const upload = await json(await apiAs(context, "GET", `/api/recording-uploads/${uploadId}/`));
    expect(upload.status).toBe("completed");
    expect(upload.result.action).toBe("replaced");
    expect(upload.result.lecture_id).toBe(autoLecture.id);
    expect(upload.result.can_switch_back).toBe(true);
    const state = await control.sessionState(obs.id);
    // One lecture: the auto-recording's, now with the uploaded video.
    expect(new Set(state.lectures.map((lecture) => lecture.id))).toEqual(new Set([autoLecture.id]));
    expect(state.recordings.map((item) => item.source).sort()).toEqual(["obs_upload", "server"]);
    await expect(page.getByText("Replaced auto-recording").first()).toBeVisible();
  });

  let token;
  await test.step("a personal upload token (desktop uploader) creates the lecture of a class without a recording", async () => {
    await page.getByLabel("Token name").fill("Laptop OBS");
    await page.getByRole("button", { name: "Create upload token" }).click();
    token = (await page.getByTestId("new-upload-token").textContent()).trim();
    expect(token.startsWith("asu_")).toBe(true);

    const uploader = await browser.newContext(); // no cookies: the token is the only credential
    const headers = { "X-Upload-Token": token };
    const small = Buffer.concat([MKV_MAGIC, Buffer.alloc(3 * MIB, 7)]);
    const created = await json(
      await uploader.request.post(`${WEB}/api/recording-uploads/`, {
        headers,
        data: { session_id: studio.id, filename: "studio take.mkv", size: small.length },
      })
    );
    expect(created.chunk_count).toBe(1);
    const put = await uploader.request.put(`${WEB}/api/recording-uploads/${created.id}/chunks/0/`, {
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      data: small,
    });
    expect(put.ok(), await put.text()).toBeTruthy();
    expect((await uploader.request.post(`${WEB}/api/recording-uploads/${created.id}/complete/`, { headers })).status()).toBe(202);
    await control.tick(["jobs"]);
    const done = await json(await uploader.request.get(`${WEB}/api/recording-uploads/${created.id}/`, { headers }));
    expect(done.status).toBe("completed");
    expect(done.result.action).toBe("created");
    const state = await control.sessionState(studio.id);
    expect(state.lectures).toHaveLength(1);
    expect(state.lectures[0].is_published).toBe(true);
    expect(state.lectures[0].module).toBe("Class recordings");

    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    const refused = await uploader.request.get(`${WEB}/api/recording-uploads/targets/`, { headers });
    expect(refused.status()).toBe(401);
    await uploader.close();
  });

  await test.step("a student sees the created lecture in the course", async () => {
    const student = await newUserContext(browser, testInfo, pageErrors, "student");
    await signIn(student, manifest, "student1");
    const lecture = (await control.sessionState(studio.id)).lectures[0];
    const studentPage = await student.newPage();
    await studentPage.goto(`/learn/${manifest.course.id}`);
    await studentPage.getByText("Class recordings").first().click();
    await expect(studentPage.getByText(lecture.title).first()).toBeVisible();
    await student.close();
  });

  fs.rmSync(path.dirname(recordingFile), { recursive: true, force: true });
});
