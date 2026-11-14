// Upload page building blocks (UI overhaul WS-D1): the drop zone (shared
// DropZone, M7b), the chunk track (M7) with its progress text, and the
// published result. OWNER: WS-D1.
import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { DropZone, PageNotification, StatusTag } from "../app-shell/ui";
import {
  RECORDING_ACCEPT,
  chunkFractions,
  formatBytes,
  formatClock,
  formatEta,
  formatSpeed,
  phaseLabel,
  resultSummary,
} from "./uploadModel";

const TEXT_INTERVAL_MS = 250; // progress text changes at most 4 times a second

/** Drag-and-drop area that is also a normal, labelled file picker. */
export function RecordingDropZone({ file, disabled, onFile }) {
  return (
    <div className="rup-dropzone">
      <DropZone
        accept={RECORDING_ACCEPT}
        disabledReason={disabled ? "An upload is running. Pause or cancel it to choose another file." : undefined}
        onFiles={(files) => {
          if (files?.[0] && !disabled) onFile(files[0]);
        }}
        label="Drop the OBS recording file here"
        hint="MKV or MP4 (also .mov, .flv, .ts), up to 8 GB."
      />
      {file ? (
        <p className="rup-file" aria-live="polite">
          <span className="rup-file__name">{file.name}</span>
          <span className="rup-file__size">{formatBytes(file.size)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Latest value, but at most once per `interval` ms (phase changes pass at once). */
export function useThrottledProgress(progress, interval = TEXT_INTERVAL_MS) {
  const [shown, setShown] = useState(progress);
  const lastRef = useRef(0);
  const timerRef = useRef(null);
  useEffect(() => {
    const now = Date.now();
    const phaseChanged = shown?.phase !== progress?.phase || !progress;
    window.clearTimeout(timerRef.current);
    if (phaseChanged || now - lastRef.current >= interval) {
      lastRef.current = now;
      setShown(progress);
      return undefined;
    }
    timerRef.current = window.setTimeout(() => {
      lastRef.current = Date.now();
      setShown(progress);
    }, interval - (now - lastRef.current));
    return () => window.clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown` is read, not followed
  }, [progress, interval]);
  return shown || progress;
}

function useSecondsSince(active) {
  const [since, setSince] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return undefined;
    }
    const started = Date.now();
    setSince(started);
    setNow(started);
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return since ? (now - since) / 1000 : 0;
}

/** M7: one cell per 32 MB part; the current cell fills with scaleX. */
export function ChunkTrack({ progress, chunkBytes, phase }) {
  const offline = phase === "retrying";
  const offlineFor = useSecondsSince(offline);
  const resumedCells = useRef(null);
  const cells = chunkFractions({
    totalBytes: progress?.totalBytes,
    chunkCount: progress?.chunkCount,
    chunkBytes,
    sentBytes: progress?.sentBytes,
  });
  if (resumedCells.current === null && cells.length && progress?.resumedBytes > 0) {
    resumedCells.current = new Set(cells.map((fraction, index) => (fraction >= 1 ? index : -1)).filter((index) => index >= 0));
  }
  if (!cells.length) return null;
  const verifying = phase === "completing" || phase === "processing";
  return (
    <div className={`rup-track${offline ? " is-offline" : ""}${phase === "done" ? " is-done" : ""}`} aria-hidden="true">
      <div className="rup-track__cells" style={{ "--rup-cells": cells.length }}>
        {cells.map((fraction, index) => (
          <span key={index} className={`rup-track__cell${resumedCells.current?.has(index) ? " is-resumed" : ""}`}>
            <span className="rup-track__fill" style={{ transform: `scaleX(${fraction})` }} />
          </span>
        ))}
      </div>
      {verifying ? <span className="rup-track__verify" /> : null}
      {offline ? <span className="rup-track__offline">Reconnecting · {formatClock(offlineFor)}</span> : null}
    </div>
  );
}

export function UploadProgress({ progress: live, chunkBytes }) {
  const progress = useThrottledProgress(live);
  if (!progress) return null;
  const helper = [
    `${formatBytes(progress.sentBytes)} of ${formatBytes(progress.totalBytes)}`,
    progress.phase === "uploading" ? formatSpeed(progress.speedBytesPerSecond) : "",
    progress.phase === "uploading" && progress.etaSeconds !== null ? `${formatEta(progress.etaSeconds)} left` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="rup-progress" aria-live="polite">
      <p className="rup-progress__label">
        <span>{`${phaseLabel(progress.phase)} – ${progress.percent}%`}</span>
      </p>
      <ChunkTrack progress={live || progress} chunkBytes={chunkBytes} phase={live?.phase || progress.phase} />
      <p className="rup-progress__helper">{helper}</p>
      {progress.resumedBytes > 0 ? <p className="rup-muted">Resumed: {formatBytes(progress.resumedBytes)} were already on the server.</p> : null}
    </div>
  );
}

function CheckDraw() {
  return (
    <svg className="rup-check" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" pathLength="1" />
      <path d="M7 12.5l3.2 3.2L17 9" pathLength="1" />
    </svg>
  );
}

export function UploadResult({ upload }) {
  const result = upload?.result;
  if (!result) return null;
  return (
    <div className="rup-result" role="status">
      <div className="rup-result__head">
        <CheckDraw />
        <StatusTag status="published" />
      </div>
      <PageNotification kind="success" title="Recording published" subtitle={resultSummary(upload)} />
      {result.learn_url ? (
        <Link className="rup-link" to={result.learn_url}>
          Open the lecture
        </Link>
      ) : null}
    </div>
  );
}
