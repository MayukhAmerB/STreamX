import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ClassRecordingStatus, { describeClassRecording, hasActiveClassRecording } from "./ClassRecordingStatus";

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

  it("says when no module will receive the recording", () => {
    const html = renderToStaticMarkup(<ClassRecordingStatus recordings={[]} targetModule={null} />);
    expect(html).toContain("No module is selected");
    expect(html).toContain("No recording yet.");
  });
});
