// Upload state machine for one recording (moved unchanged from the old
// ConsoleRecordingUploadPage): start → chunks (engine) → complete → poll
// until the server published it. OWNER: WS-D1.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { abortUpload, completeUpload, createUpload, getUpload, putChunk } from "./recordingUploadsApi";
import { createChunkUploader } from "./uploadEngine";
import { resultSummary, resumeRecordFor, writeResumeRecord } from "./uploadModel";

export const POLL_MS = 2500;
export const ACTIVE_PHASES = new Set(["uploading", "retrying", "paused", "completing"]);

export default function useUploadFlow({ showToast, onFinished }) {
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(null);
  const [upload, setUpload] = useState(null);
  const [error, setError] = useState("");
  const uploaderRef = useRef(null);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPolling, []);

  const poll = useCallback(
    (id) => {
      stopPolling();
      const check = async () => {
        try {
          const current = apiData(await getUpload(id));
          setUpload(current);
          if (current.status === "completed") {
            stopPolling();
            writeResumeRecord(null);
            setPhase("done");
            showToast?.({ kind: "success", title: "Recording published", subtitle: resultSummary(current) });
            onFinished?.();
          } else if (["failed", "aborted", "expired"].includes(current.status)) {
            stopPolling();
            writeResumeRecord(null);
            setPhase("failed");
            setError(current.error || `The upload is ${current.status_label.toLowerCase()}.`);
            onFinished?.();
          }
        } catch {
          // Keep polling through short outages.
        }
      };
      check();
      pollRef.current = setInterval(check, POLL_MS);
    },
    [onFinished, showToast]
  );

  const start = useCallback(
    async ({ sessionId, file }) => {
      setError("");
      setPhase("uploading");
      let started;
      try {
        started = apiData(await createUpload({ sessionId, file }));
      } catch (problem) {
        setPhase("idle");
        setError(apiMessage(problem, "The upload could not start."));
        return;
      }
      setUpload(started);
      writeResumeRecord(resumeRecordFor(started, file, sessionId));
      if (started.status !== "uploading") {
        setPhase("processing");
        poll(started.id);
        return;
      }
      const uploader = createChunkUploader({
        upload: started,
        file,
        api: { putChunk, completeUpload, abortUpload },
        onUpdate: (snapshot) => {
          setProgress(snapshot);
          setPhase(snapshot.phase);
        },
      });
      uploaderRef.current = uploader;
      try {
        const queued = await uploader.start();
        if (queued) {
          setUpload(apiData(queued));
          poll(started.id);
        }
      } catch (problem) {
        setError(problem?.message || "The upload failed.");
        setPhase("failed");
      } finally {
        uploaderRef.current = null;
      }
    },
    [poll]
  );

  const pause = () => uploaderRef.current?.pause();
  const resume = () => uploaderRef.current?.resume();
  const cancel = async () => {
    const uploader = uploaderRef.current;
    writeResumeRecord(null);
    try {
      if (uploader) await uploader.cancel();
      else if (upload?.id) await abortUpload(upload.id);
    } catch (problem) {
      setError(apiMessage(problem, "The upload could not be cancelled."));
    }
    stopPolling();
    setPhase("cancelled");
    onFinished?.();
  };
  const reset = () => {
    stopPolling();
    setPhase("idle");
    setProgress(null);
    setUpload(null);
    setError("");
  };
  return { phase, progress, upload, error, start, pause, resume, cancel, reset, poll, setUpload, setPhase };
}
