import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { RecordingDropZone, UploadProgress, UploadResult, UploadTokensPanel } from "../../pages/ConsoleRecordingUploadPage";
import {
  fileMatchesRecord,
  formatBytes,
  formatEta,
  isRecordingFile,
  readResumeRecord,
  RESUME_STORAGE_KEY,
  resultSummary,
  targetLabel,
  targetOutcome,
  writeResumeRecord,
} from "./uploadModel";

function html(element) {
  return renderToStaticMarkup(<StaticRouter location="/console/recordings/upload">{element}</StaticRouter>);
}

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

describe("recording upload model", () => {
  it("formats sizes, speeds and time left", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(formatBytes(200 * 1024 ** 2)).toBe("200 MB");
    expect(formatEta(42)).toBe("42 s");
    expect(formatEta(125)).toBe("2 min 5 s");
    expect(formatEta(3 * 3600 + 120)).toBe("3 h 2 min");
    expect(formatEta(null)).toBe("–");
  });

  it("accepts only OBS recording containers", () => {
    expect(isRecordingFile({ name: "2026-11-14 19-00-01.mkv" })).toBe(true);
    expect(isRecordingFile({ name: "class.MP4" })).toBe(true);
    expect(isRecordingFile({ name: "notes.pdf" })).toBe(false);
    expect(isRecordingFile({ name: "mkv" })).toBe(false);
  });

  it("explains what an upload will do to the class", () => {
    expect(targetOutcome({ action: "replaced", lecture_title: "Recon - 14 Nov", module_title: "Recon" })).toContain(
      "Replaces the video of “Recon - 14 Nov” in Recon"
    );
    expect(targetOutcome({ action: "created", module_title: "Class recordings" })).toBe(
      "Creates and publishes the lecture in Class recordings."
    );
    expect(targetLabel({ title: "Recon", course_title: "OSINT", status: "live" })).toBe("Recon · OSINT · live now");
    expect(resultSummary({ result: { action: "replaced", lecture_title: "Recon" } })).toContain("replaced the auto-recording");
  });

  it("remembers the unfinished upload across a refresh and survives broken storage", () => {
    const storage = memoryStorage();
    writeResumeRecord({ id: "u-1", name: "a.mkv", size: 10, sessionId: 3 }, storage);
    expect(readResumeRecord(storage)).toEqual({ id: "u-1", name: "a.mkv", size: 10, sessionId: 3 });
    expect(fileMatchesRecord({ name: "a.mkv", size: 10 }, readResumeRecord(storage))).toBe(true);
    expect(fileMatchesRecord({ name: "a.mkv", size: 11 }, readResumeRecord(storage))).toBe(false);
    writeResumeRecord(null, storage);
    expect(readResumeRecord(storage)).toBeNull();
    storage.setItem(RESUME_STORAGE_KEY, "{broken");
    expect(readResumeRecord(storage)).toBeNull();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(readResumeRecord(throwing)).toBeNull();
    expect(() => writeResumeRecord({ id: "x" }, throwing)).not.toThrow();
  });
});

describe("recording upload UI", () => {
  it("drop zone is a labelled file input accepting recordings", () => {
    const markup = html(<RecordingDropZone file={null} onFile={() => {}} />);
    expect(markup).toContain('aria-label="Recording file"');
    expect(markup).toContain("Drop the OBS recording here");
    expect(markup).toContain(".mkv");
    expect(html(<RecordingDropZone file={{ name: "class.mkv", size: 2 * 1024 ** 3 }} onFile={() => {}} />)).toContain("2.0 GB");
  });

  it("shows progress, speed, time left and what was resumed", () => {
    const markup = html(
      <UploadProgress
        progress={{
          phase: "uploading",
          percent: 40,
          sentBytes: 400 * 1024 ** 2,
          totalBytes: 1000 * 1024 ** 2,
          speedBytesPerSecond: 8 * 1024 ** 2,
          etaSeconds: 75,
          resumedBytes: 96 * 1024 ** 2,
        }}
      />
    );
    expect(markup).toContain("Uploading – 40%");
    expect(markup).toContain("400 MB of 1000 MB · 8.0 MB/s · 1 min 15 s left");
    expect(markup).toContain("Resumed: 96.0 MB were already on the server.");
  });

  it("links to the published lecture", () => {
    const markup = html(
      <UploadResult upload={{ result: { action: "created", lecture_title: "Recon - 14 Nov", learn_url: "/learn/4?lecture=9" } }} />
    );
    expect(markup).toContain('href="/learn/4?lecture=9"');
    expect(markup).toContain("“Recon - 14 Nov” was created and published.");
  });

  it("shows a new token once and lists tokens with revoke", () => {
    const markup = html(
      <UploadTokensPanel
        tokens={[
          { id: 1, name: "OBS laptop", prefix: "asu_abcdefgh", active: true, last_used_at: null },
          { id: 2, name: "Old", prefix: "asu_zzzzzzzz", active: false, revoked_at: "2026-11-01T00:00:00Z" },
        ]}
        created={{ id: 1, token: "asu_SECRET" }}
        onCreate={() => {}}
        onRevoke={() => {}}
        onReload={() => {}}
      />
    );
    expect(markup).toContain("asu_SECRET");
    expect(markup).toContain("shown only once");
    expect(markup).toContain("Revoke");
    expect(markup).toContain("Revoked");
    expect(markup).toContain("Automatically remux to mp4");
    expect(markup).toContain("Settings → Output → Recording");
  });
});
