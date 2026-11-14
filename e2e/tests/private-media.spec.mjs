// Private media (Phase 1 security, kept by Phase 2/3): paid lecture files and
// resources are never served from /media/ directly (404 through the nginx
// rules the gateway applies); an enrolled student downloads the resource
// through the access-checked API (X-Accel-Redirect), others cannot.
import { apiAs, expect, signIn, test, WEB } from "./helpers.mjs";

test("private media: /media/ URLs 404, the authorised download works", async ({ page, context, browser, manifest }) => {
  const resource = manifest.resource;
  const downloadPath = `/api/lectures/${resource.lecture_id}/resources/${resource.id}/download/`;

  await test.step("direct /media/ URLs of protected files answer 404, signed in or not", async () => {
    for (const path of [resource.media_path, manifest.lecture_video_media_path, "/media/realtime_recordings/x.webm", "/_protected_media/" + resource.media_path.replace(/^\/media\//, "")]) {
      const anonymous = await page.request.get(`${WEB}${path}`);
      expect(anonymous.status(), `anonymous ${path}`).toBe(404);
    }
    await signIn(context, manifest, "student1");
    const signedIn = await context.request.get(`${WEB}${resource.media_path}`);
    expect(signedIn.status(), "enrolled student, direct media URL").toBe(404);
  });

  await test.step("the enrolled student downloads it through the API", async () => {
    const response = await apiAs(context, "GET", downloadPath);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"] || "").toContain("workspace-checklist");
    expect(response.headers()["x-accel-redirect"], "nginx consumes X-Accel-Redirect").toBeUndefined();
    const body = await response.body();
    expect(body.toString("latin1")).toContain("% E2E resource");
  });

  await test.step("the course player offers the resource to the student", async () => {
    await page.goto(`/learn/${manifest.course.id}`);
    await expect(page.getByText(manifest.lectures[0].title).first()).toBeVisible();
    const resourceLink = page.getByText("Workspace checklist").first();
    // Phone layout: lesson resources live in the "Overview" tab.
    if (!(await resourceLink.isVisible().catch(() => false))) await page.getByRole("tab", { name: "Overview" }).click();
    await expect(resourceLink).toBeVisible();
  });

  await test.step("a student outside the batch and a visitor cannot download it", async () => {
    const other = await browser.newContext({ baseURL: WEB });
    const anonymous = await other.request.get(`${WEB}${downloadPath}`);
    expect([401, 403, 404]).toContain(anonymous.status());
    await signIn(other, manifest, "outsider");
    const outsider = await apiAs(other, "GET", downloadPath);
    expect([403, 404]).toContain(outsider.status());
    await other.close();
  });
});
