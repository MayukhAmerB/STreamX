import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ClassRecordingStatus, {
  canRerunFinalize,
  describeClassRecording,
  hasActiveClassRecording,
} from "./ClassRecordingStatus";

function recording(overrides = {}) {
  return {
    id: 1,
    session_id: 9,
    source: "server",
    state: "recording",
    module: { id: 4, title: "Module 2: Recon", course_id: 3 },
    lecture: null,
    error: "",
    part_count: 0,
    captured_bytes: 0,
    file_size_bytes: null,
    duration_seconds: null,
    attempts: 0,
    recorder_heartbeat_at: null,
    started_at: null,
    stop_requested_at: null,
    finalized_at: null,
    published_at: null,
    created_at: "2026-11-10T10:00:00Z",
    updated_at: "2026-11-10T10:00:00Z",
    can_retry: false,
    can_replace: false,
    can_choose_module: true,
    needs_review: false,
    review_reason: "",
    ...overrides,
  };
}

describe("describeClassRecording", () => {
  it("walks the saving states to the published module", () => {
    expect(describeClassRecording(recording({ state: "recording" })).label).toBe("Recording the class...");
    expect(describeClassRecording(recording({ state: "finalizing" })).label).toBe("Saving recording...");
    expect(describeClassRecording(recording({ state: "processing" })).label).toBe("Saving recording...");
    expect(describeClassRecording(recording({ state: "published" })).label).toBe("Published to Module 2: Recon");
    expect(describeClassRecording(recording({ state: "published", module: null })).label).toBe("Published");
  });

  it("explains failures", () => {
    const failed = describeClassRecording(recording({ state: "failed", error: "ffmpeg exited 1" }));
    expect(failed).toEqual({ tone: "failed", label: "Recording failed: ffmpeg exited 1" });
  });

  it("knows when a recording is still being saved", () => {
    expect(hasActiveClassRecording([recording({ state: "published" }), recording({ state: "finalizing" })])).toBe(true);
    expect(hasActiveClassRecording([recording({ state: "published" }), recording({ state: "failed" })])).toBe(false);
    expect(hasActiveClassRecording(null)).toBe(false);
  });
});

describe("ClassRecordingStatus", () => {
  it("offers a retry only for failed recordings that can be retried", () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(
      <ClassRecordingStatus
        recordings={[
          recording({ id: 1, state: "failed", error: "upload lost", can_retry: true }),
          recording({ id: 2, state: "failed", error: "gone", can_retry: false }),
        ]}
        targetModule={{ id: 4, title: "Module 2: Recon" }}
        onRetry={onRetry}
      />
    );
    expect(html.match(/>Retry</g)).toHaveLength(1);
    expect(html).toContain("Recording failed: upload lost");
    expect(html).toContain('role="alert"');
    expect(html).toContain("published to Module 2: Recon");
  });

  it("explains that recording is automatic, with or without a module", () => {
    const html = renderToStaticMarkup(<ClassRecordingStatus recordings={[]} targetModule={null} />);
    expect(html).toContain("recorded automatically");
    expect(html).toContain("Class recordings");
    expect(html).toContain("No recording yet. It starts by itself");
    expect(html).not.toMatch(/Start recording|Stop recording/i);
    const tagged = renderToStaticMarkup(<ClassRecordingStatus recordings={[]} targetModule={{ title: "Recon" }} />);
    expect(tagged).toContain("published to Recon when it ends");
  });

  it("offers the optional module picker and flags recordings that need review", () => {
    const html = renderToStaticMarkup(
      <ClassRecordingStatus
        recordings={[
          recording({
            id: 7,
            state: "processing",
            module: { id: 9, title: "Class recordings", course_id: 3 },
            lecture: { id: 5, title: "Recon - 13 Nov", stream_status: "uploaded", is_published: true },
            needs_review: true,
            review_reason: "No module was chosen for this class.",
          }),
        ]}
        moduleOptions={[
          { id: 4, title: "Module 2: Recon" },
          { id: 9, title: "Class recordings" },
        ]}
        onChangeModule={vi.fn()}
      />
    );
    expect(html).toContain('id="class-recording-module-7"');
    expect(html).toContain("Module 2: Recon");
    expect(html).toContain("Needs review: No module was chosen for this class.");
    expect(html).toContain("Published to Class recordings (HD processing)");
  });

  it("disables the picker while the recording is being saved", () => {
    const html = renderToStaticMarkup(
      <ClassRecordingStatus
        recordings={[recording({ id: 3, state: "finalizing", can_choose_module: false })]}
        moduleOptions={[{ id: 4, title: "Module 2: Recon" }]}
        onChangeModule={vi.fn()}
      />
    );
    expect(html).toMatch(/<select[^>]*disabled/);
  });

  it("shows Re-run finalize to admins only", () => {
    const rows = [recording({ id: 1, state: "failed", error: "x" })];
    const admin = renderToStaticMarkup(<ClassRecordingStatus recordings={rows} isAdmin onRerunFinalize={vi.fn()} />);
    expect(admin).toContain("Re-run finalize");
    const host = renderToStaticMarkup(<ClassRecordingStatus recordings={rows} onRerunFinalize={vi.fn()} />);
    expect(host).not.toContain("Re-run finalize");
  });
});

describe("recording helpers", () => {
  it("does not poll fast for hours while only the HD stream is building", () => {
    const published = { id: 5, title: "x", stream_status: "processing", is_published: true };
    expect(hasActiveClassRecording([recording({ state: "processing", lecture: published })])).toBe(false);
    expect(hasActiveClassRecording([recording({ state: "processing", lecture: null })])).toBe(true);
  });

  it("knows which recordings can be re-run", () => {
    expect(canRerunFinalize(recording({ state: "failed" }))).toBe(true);
    expect(canRerunFinalize(recording({ state: "recording" }))).toBe(true);
    expect(canRerunFinalize(recording({ state: "finalizing" }))).toBe(false);
    expect(canRerunFinalize(recording({ state: "published" }))).toBe(false);
  });
});
