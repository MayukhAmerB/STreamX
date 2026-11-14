import "../features/recording-uploads/RecordingUploads.scss";

import { Copy, Pause, Play, StopFilledAlt, TrashCan, Upload, VideoAdd } from "@carbon/icons-react";
import { Button, ProgressBar, Select, SelectItem, Tag, TextInput } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, useToast } from "../features/app-shell/ui";
import {
  abortUpload,
  completeUpload,
  createUpload,
  createUploadToken,
  getUpload,
  listMyUploads,
  listUploadTargets,
  listUploadTokens,
  putChunk,
  revokeUploadToken,
} from "../features/recording-uploads/recordingUploadsApi";
import { createChunkUploader } from "../features/recording-uploads/uploadEngine";
import {
  RECORDING_ACCEPT,
  fileMatchesRecord,
  formatBytes,
  formatEta,
  formatSpeed,
  isRecordingFile,
  phaseLabel,
  readResumeRecord,
  resultSummary,
  resumeRecordFor,
  targetLabel,
  targetOutcome,
  writeResumeRecord,
} from "../features/recording-uploads/uploadModel";
import { apiData, apiMessage } from "../utils/api";

const POLL_MS = 2500;
const ACTIVE_PHASES = new Set(["uploading", "retrying", "paused", "completing"]);
const STATUS_TAGS = {
  uploading: "blue",
  queued: "cyan",
  assembling: "cyan",
  completed: "green",
  failed: "red",
  aborted: "gray",
  expired: "gray",
};

const formatWhen = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value))
    : "";

/** Drag-and-drop area that is also a normal file picker (keyboard and screen readers). */
export function RecordingDropZone({ file, disabled, onFile }) {
  const [over, setOver] = useState(false);
  const pick = (picked) => {
    if (picked && !disabled) onFile(picked);
  };
  return (
    <label
      className={`rup-drop${over ? " rup-drop--over" : ""}${disabled ? " rup-drop--disabled" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        pick(event.dataTransfer?.files?.[0]);
      }}
    >
      <VideoAdd size={32} aria-hidden="true" />
      <span className="rup-drop__title">{file ? file.name : "Drop the OBS recording here"}</span>
      <span className="rup-muted">{file ? formatBytes(file.size) : "or click to choose it (MKV or MP4, up to 8 GB)"}</span>
      <input
        className="rup-drop__input"
        type="file"
        accept={RECORDING_ACCEPT}
        aria-label="Recording file"
        disabled={disabled}
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </label>
  );
}

export function UploadProgress({ progress }) {
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
      <ProgressBar
        label={`${phaseLabel(progress.phase)} – ${progress.percent}%`}
        value={progress.percent}
        max={100}
        helperText={helper}
        status={progress.phase === "failed" ? "error" : progress.percent >= 100 && progress.phase === "processing" ? "finished" : "active"}
      />
      {progress.resumedBytes > 0 ? (
        <p className="rup-muted">Resumed: {formatBytes(progress.resumedBytes)} were already on the server.</p>
      ) : null}
    </div>
  );
}

function useUploadFlow({ showToast, onFinished }) {
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

export function UploadResult({ upload }) {
  const result = upload?.result;
  if (!result) return null;
  return (
    <div className="rup-result" role="status">
      <PageNotification kind="success" title="Recording published" subtitle={resultSummary(upload)} />
      {result.learn_url ? (
        <Link className="rup-link" to={result.learn_url}>
          Open the lecture
        </Link>
      ) : null}
    </div>
  );
}

export function UploadTokensPanel({ tokens, loading, error, created, busy, onCreate, onRevoke, onReload }) {
  const [name, setName] = useState("OBS laptop");
  const { showToast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      showToast({ kind: "success", title: "Token copied" });
    } catch {
      showToast({ kind: "warning", title: "Copy it by hand", subtitle: "Select the token and copy it." });
    }
  };
  return (
    <section className="rup-section rup-card" aria-labelledby="rup-tokens-title">
      <h2 id="rup-tokens-title" className="rup-subtitle">
        Automatic upload from your laptop
      </h2>
      <p className="rup-muted">
        The desktop uploader notices when OBS stops recording and uploads the file to that class on its own. It signs in with a
        personal upload token: the token can only upload class recordings, and you can revoke it at any time.
      </p>
      <form
        className="rup-row"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name);
        }}
      >
        <TextInput id="rup-token-name" labelText="Token name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" kind="secondary" size="md" disabled={!name.trim() || busy}>
          Create upload token
        </Button>
      </form>
      {created ? (
        <div className="rup-token" role="status">
          <p className="rup-check-label">Copy this token now. It is shown only once.</p>
          <code className="rup-token__value" data-testid="new-upload-token">
            {created.token}
          </code>
          <Button kind="ghost" size="sm" renderIcon={Copy} onClick={copy}>
            Copy
          </Button>
        </div>
      ) : null}
      {loading ? <PageSkeleton label="Loading tokens" count={1} /> : null}
      {error ? <PageNotification kind="error" title="Couldn't load tokens." subtitle={error} actionLabel="Try again" onAction={onReload} /> : null}
      {!loading && tokens.length ? (
        <ul className="rup-list" aria-label="Upload tokens">
          {tokens.map((token) => (
            <li key={token.id} className="rup-list__item">
              <div>
                <strong>{token.name}</strong> <span className="rup-muted">{token.prefix}…</span>
                <div className="rup-muted">
                  {token.last_used_at ? `Last used ${formatWhen(token.last_used_at)}` : "Never used"}
                </div>
              </div>
              {token.active ? (
                <Button kind="danger--ghost" size="sm" renderIcon={TrashCan} disabled={busy} onClick={() => onRevoke(token)}>
                  Revoke
                </Button>
              ) : (
                <Tag type="gray" size="sm">
                  {token.revoked_at ? "Revoked" : "Expired"}
                </Tag>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <details className="rup-guide">
        <summary>Set up OBS and the desktop uploader</summary>
        <ol>
          <li>
            In OBS open <strong>Settings → Output → Recording</strong>. <strong>Recording Path</strong> is where OBS saves the file
            (by default <code>C:\Users\&lt;you&gt;\Videos</code>).
          </li>
          <li>
            In <strong>Settings → Advanced</strong> turn on <strong>Automatically remux to mp4</strong>. MKV files are accepted too
            and are converted on the server.
          </li>
          <li>
            In OBS open <strong>Tools → WebSocket Server Settings</strong>, enable the server (port 4455) and copy its password.
          </li>
          <li>
            Install <code>obs-uploader.exe</code> and put this in <code>%APPDATA%\obs-uploader\config.toml</code>:
            <pre className="rup-code">{`api_base = "https://api.alsyedinitiative.com/api"
token = "<the upload token>"
recordings_dir = 'C:\\Users\\<you>\\Videos'
obs_websocket_password = "<the OBS WebSocket password>"`}</pre>
          </li>
          <li>
            Run <code>obs-uploader.exe install-task</code> once: it starts with Windows and waits for OBS. Each recording goes to
            your live class (or the one that ended last) automatically.
          </li>
        </ol>
      </details>
    </section>
  );
}

export default function ConsoleRecordingUploadPage() {
  const { showToast } = useToast();
  const [targets, setTargets] = useState({ items: [], loading: true, error: "" });
  const [sessionId, setSessionId] = useState("");
  const [file, setFile] = useState(null);
  const [fileProblem, setFileProblem] = useState("");
  const [recent, setRecent] = useState([]);
  const [resumeRecord, setResumeRecord] = useState(() => readResumeRecord());
  const [tokenState, setTokenState] = useState({ items: [], loading: true, error: "", created: null, busy: false });

  const loadTargets = useCallback(() => {
    setTargets((current) => ({ ...current, loading: true, error: "" }));
    listUploadTargets()
      .then((response) => {
        const items = apiData(response, []);
        setTargets({ items, loading: false, error: "" });
        setSessionId((current) => current || (items[0] ? String(items[0].session_id) : ""));
      })
      .catch((error) => setTargets({ items: [], loading: false, error: apiMessage(error, "Please try again.") }));
  }, []);
  const loadRecent = useCallback(() => {
    listMyUploads()
      .then((response) => setRecent(apiData(response, [])))
      .catch(() => setRecent([]));
  }, []);
  const loadTokens = useCallback(() => {
    setTokenState((current) => ({ ...current, loading: true, error: "" }));
    listUploadTokens()
      .then((response) => setTokenState((current) => ({ ...current, items: apiData(response, []), loading: false })))
      .catch((error) => setTokenState((current) => ({ ...current, loading: false, error: apiMessage(error, "Please try again.") })));
  }, []);

  const refresh = useCallback(() => {
    loadRecent();
    loadTargets();
    setResumeRecord(readResumeRecord());
  }, [loadRecent, loadTargets]);
  const flow = useUploadFlow({ showToast, onFinished: refresh });

  useEffect(() => {
    loadTargets();
    loadRecent();
    loadTokens();
  }, [loadTargets, loadRecent, loadTokens]);

  // A refreshed page: the stored upload decides what to offer.
  const resumable = useMemo(() => {
    if (!resumeRecord) return null;
    const match = recent.find((item) => item.id === resumeRecord.id);
    return match && match.status === "uploading" ? match : null;
  }, [recent, resumeRecord]);
  const processingAfterRefresh = useMemo(() => {
    if (!resumeRecord || flow.phase !== "idle") return null;
    const match = recent.find((item) => item.id === resumeRecord.id);
    return match && ["queued", "assembling", "completed"].includes(match.status) ? match : null;
  }, [recent, resumeRecord, flow.phase]);
  const { poll, setPhase, setUpload } = flow;
  useEffect(() => {
    if (processingAfterRefresh) {
      setUpload(processingAfterRefresh);
      setPhase("processing");
      poll(processingAfterRefresh.id);
    }
  }, [processingAfterRefresh, poll, setPhase, setUpload]);
  // The unfinished upload belongs to one class: preselect it.
  useEffect(() => {
    if (resumable?.session_id) setSessionId(String(resumable.session_id));
  }, [resumable]);

  const target = targets.items.find((item) => String(item.session_id) === sessionId) || null;
  const busy = ACTIVE_PHASES.has(flow.phase) || flow.phase === "processing";

  const onFile = (picked) => {
    if (!isRecordingFile(picked)) {
      setFile(null);
      setFileProblem("Choose the video file OBS saved (MKV, MP4, MOV, FLV or TS).");
      return;
    }
    setFileProblem("");
    setFile(picked);
    if (flow.phase !== "idle" && !busy) flow.reset();
  };

  const startUpload = () => {
    if (!file || !sessionId) return;
    flow.start({ sessionId: Number(sessionId), file });
  };

  const discardResume = async () => {
    if (resumable) {
      try {
        await abortUpload(resumable.id);
      } catch {
        // Already gone on the server.
      }
    }
    writeResumeRecord(null);
    setResumeRecord(null);
    loadRecent();
  };

  const createToken = async (name) => {
    setTokenState((current) => ({ ...current, busy: true, created: null }));
    try {
      const created = apiData(await createUploadToken(name));
      setTokenState((current) => ({ ...current, busy: false, created }));
      loadTokens();
    } catch (error) {
      setTokenState((current) => ({ ...current, busy: false }));
      showToast({ kind: "error", title: "Token not created", subtitle: apiMessage(error, "Please try again.") });
    }
  };
  const revokeToken = async (token) => {
    setTokenState((current) => ({ ...current, busy: true }));
    try {
      await revokeUploadToken(token.id);
      showToast({ kind: "success", title: "Token revoked", subtitle: `${token.name} can no longer upload.` });
    } catch (error) {
      showToast({ kind: "error", title: "Token not revoked", subtitle: apiMessage(error, "Please try again.") });
    }
    setTokenState((current) => ({ ...current, busy: false, created: current.created?.id === token.id ? null : current.created }));
    loadTokens();
  };

  const matchesResume = resumable && fileMatchesRecord(file, resumeRecord);

  return (
    <>
      <PageHeader
        title="Upload class recording"
        description="Upload the better-quality file OBS saved on your laptop. It replaces the server's auto-recording of that class, or creates the lecture."
      />
      {resumable && !busy && flow.phase === "idle" ? (
        <PageNotification
          kind="info"
          title={`Unfinished upload: ${resumable.filename}`}
          subtitle={`${resumable.received_count} of ${resumable.chunk_count} parts are already on the server. Choose the same file again to continue where it stopped.`}
          actionLabel="Discard it"
          onAction={discardResume}
        />
      ) : null}
      <section className="rup-section rup-card" aria-labelledby="rup-upload-title">
        <h2 id="rup-upload-title" className="rup-subtitle">
          Upload a recording
        </h2>
        {targets.loading ? <PageSkeleton label="Loading classes" count={1} /> : null}
        {targets.error ? (
          <PageNotification kind="error" title="Couldn't load your classes." subtitle={targets.error} actionLabel="Try again" onAction={loadTargets} />
        ) : null}
        {!targets.loading && !targets.error && !targets.items.length ? (
          <EmptyState icon={VideoAdd} text="No recent class of yours is linked to a course yet." />
        ) : null}
        {targets.items.length ? (
          <>
            <Select
              id="rup-class"
              labelText="Class"
              value={sessionId}
              disabled={busy}
              onChange={(event) => setSessionId(event.target.value)}
            >
              {targets.items.map((item) => (
                <SelectItem key={item.session_id} value={String(item.session_id)} text={targetLabel(item, formatWhen)} />
              ))}
            </Select>
            {target ? (
              <p className="rup-muted rup-outcome">
                {targetOutcome(target)}
                {target.auto_recording_pending ? " The server's auto-recording is still being finished; your file will replace it when it is." : ""}
              </p>
            ) : null}
            <RecordingDropZone file={file} disabled={busy} onFile={onFile} />
            {fileProblem ? <PageNotification kind="error" title="Not a recording" subtitle={fileProblem} /> : null}
            {matchesResume && flow.phase === "idle" ? (
              <p className="rup-muted">This is the unfinished upload: only the missing parts are sent.</p>
            ) : null}
            <div className="rup-row">
              {!busy ? (
                <Button kind="primary" size="md" renderIcon={Upload} disabled={!file || !sessionId} onClick={startUpload}>
                  {matchesResume ? "Resume upload" : "Upload"}
                </Button>
              ) : null}
              {flow.phase === "uploading" || flow.phase === "retrying" ? (
                <Button kind="secondary" size="md" renderIcon={Pause} onClick={flow.pause}>
                  Pause
                </Button>
              ) : null}
              {flow.phase === "paused" ? (
                <Button kind="secondary" size="md" renderIcon={Play} onClick={flow.resume}>
                  Resume
                </Button>
              ) : null}
              {ACTIVE_PHASES.has(flow.phase) ? (
                <Button kind="danger--tertiary" size="md" renderIcon={StopFilledAlt} onClick={flow.cancel}>
                  Cancel upload
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
        <UploadProgress progress={flow.progress} />
        {flow.phase === "retrying" && flow.progress?.retry ? (
          <PageNotification
            kind="warning"
            title="Connection lost"
            subtitle={`${flow.progress.retry.message} Retrying automatically (attempt ${flow.progress.retry.attempt}). Nothing already sent is lost.`}
          />
        ) : null}
        {flow.phase === "processing" ? (
          <PageNotification
            kind="info"
            title="Upload complete – processing on the server"
            subtitle={
              flow.upload?.waiting_for_auto_recording
                ? "Waiting for the server's auto-recording of this class to finish, then your file replaces it."
                : "The file is checked and published. You can leave this page; it finishes on its own."
            }
          />
        ) : null}
        {flow.error ? <PageNotification kind="error" title="Upload problem" subtitle={flow.error} /> : null}
        {flow.phase === "done" ? <UploadResult upload={flow.upload} /> : null}
        {flow.phase === "cancelled" ? <PageNotification kind="info" title="Upload cancelled" subtitle="The parts already sent were deleted." /> : null}
      </section>

      <UploadTokensPanel
        tokens={tokenState.items}
        loading={tokenState.loading}
        error={tokenState.error}
        created={tokenState.created}
        busy={tokenState.busy}
        onCreate={createToken}
        onRevoke={revokeToken}
        onReload={loadTokens}
      />

      <section className="rup-section" aria-labelledby="rup-recent-title">
        <h2 id="rup-recent-title" className="rup-subtitle">
          Your recent uploads
        </h2>
        {!recent.length ? <p className="rup-muted">No uploads yet.</p> : null}
        {recent.length ? (
          <ul className="rup-list" aria-label="Recent uploads">
            {recent.map((item) => (
              <li key={item.id} className="rup-list__item">
                <div>
                  <strong>{item.filename}</strong> <span className="rup-muted">{formatBytes(item.total_bytes)}</span>
                  <div className="rup-muted">
                    {item.session_title} · {formatWhen(item.created_at)}
                    {item.via_token ? " · desktop uploader" : ""}
                  </div>
                  {item.error ? <div className="rup-error">{item.error}</div> : null}
                </div>
                <div className="rup-list__end">
                  <Tag type={STATUS_TAGS[item.status] || "gray"} size="sm">
                    {item.status === "completed" && item.result?.action === "replaced" ? "Replaced auto-recording" : item.status_label}
                  </Tag>
                  {item.result?.learn_url ? (
                    <Link className="rup-link" to={item.result.learn_url}>
                      Open
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
