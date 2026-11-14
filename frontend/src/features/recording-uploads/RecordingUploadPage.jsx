// Upload class recording (T4): choose the class, drop the OBS file, watch
// the chunk track; resumes after a dropped connection or a page refresh.
// Desktop uploader tokens sit in a secondary disclosure below the task.
// Mounted at /console/{ws}/recordings/upload (and the old
// /console/recordings/upload). OWNER: WS-D1.
import "./RecordingUploads.scss";

import { Pause, Play, StopFilledAlt, Upload, VideoAdd } from "@carbon/icons-react";
import { Button, Select, SelectItem } from "@carbon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { EmptyState, PageHeader, PageNotification, PageSkeleton, T4Form, useToast } from "../app-shell/ui";
import { classesPath, workspaceRootFor } from "../classes/classesModel";
import RecentUploads from "./RecentUploads";
import {
  abortUpload,
  createUploadToken,
  listMyUploads,
  listUploadTargets,
  listUploadTokens,
  revokeUploadToken,
} from "./recordingUploadsApi";
import { RecordingDropZone, UploadProgress, UploadResult } from "./UploadPieces";
import DesktopUploaderSection from "./UploadTokensPanel";
import useUploadFlow, { ACTIVE_PHASES } from "./useUploadFlow";
import { fileMatchesRecord, isRecordingFile, readResumeRecord, targetLabel, targetOutcome, writeResumeRecord } from "./uploadModel";

const formatWhen = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value))
    : "";

function useUploadData() {
  const [targets, setTargets] = useState({ items: [], loading: true, error: "" });
  const [recent, setRecent] = useState([]);
  const [tokenState, setTokenState] = useState({ items: [], loading: true, error: "", created: null, busy: false });
  const loadTargets = useCallback(() => {
    setTargets((current) => ({ ...current, loading: true, error: "" }));
    return listUploadTargets()
      .then((response) => {
        const items = apiData(response, []);
        setTargets({ items, loading: false, error: "" });
        return items;
      })
      .catch((error) => {
        setTargets({ items: [], loading: false, error: apiMessage(error, "Please try again.") });
        return [];
      });
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
  return { targets, recent, tokenState, setTokenState, loadTargets, loadRecent, loadTokens };
}

export default function RecordingUploadPage() {
  const { showToast } = useToast();
  const { pathname } = useLocation();
  const { isAdmin } = useAuth() || {};
  const root = workspaceRootFor(pathname, { isAdmin });
  const data = useUploadData();
  const { targets, recent, tokenState, setTokenState, loadTargets, loadRecent, loadTokens } = data;
  const [sessionId, setSessionId] = useState("");
  const [file, setFile] = useState(null);
  const [fileProblem, setFileProblem] = useState("");
  const [resumeRecord, setResumeRecord] = useState(() => readResumeRecord());

  const reloadTargets = useCallback(() => {
    loadTargets().then((items) => setSessionId((current) => current || (items[0] ? String(items[0].session_id) : "")));
  }, [loadTargets]);
  const refresh = useCallback(() => {
    loadRecent();
    reloadTargets();
    setResumeRecord(readResumeRecord());
  }, [loadRecent, reloadTargets]);
  const flow = useUploadFlow({ showToast, onFinished: refresh });

  useEffect(() => {
    reloadTargets();
    loadRecent();
    loadTokens();
  }, [reloadTargets, loadRecent, loadTokens]);

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
  const matchesResume = resumable && fileMatchesRecord(file, resumeRecord);

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

  const activeTokens = tokenState.items.filter((token) => token.active).length;
  const showTask = targets.items.length > 0;

  return (
    <T4Form
      header={
        <PageHeader
          title="Upload class recording"
          eyebrow={null}
          description="Upload the better copy OBS saved on your computer. It replaces the server's auto-recording of that class, or becomes the lecture."
        />
      }
    >
      {resumable && !busy && flow.phase === "idle" ? (
        <PageNotification
          kind="info"
          title={`Unfinished upload: ${resumable.filename}`}
          subtitle={`${resumable.received_count} of ${resumable.chunk_count} parts are already on the server. Choose the same file again to continue where it stopped.`}
          actionLabel="Discard it"
          onAction={discardResume}
        />
      ) : null}

      <section className="rup-section rup-task" aria-labelledby="rup-upload-title">
        <h2 id="rup-upload-title" className="cds--visually-hidden">
          Upload a recording
        </h2>
        {targets.loading ? <PageSkeleton label="Loading classes" count={2} variant="form" /> : null}
        {targets.error ? (
          <PageNotification kind="error" title="Couldn't load your classes." subtitle={targets.error} actionLabel="Try again" onAction={reloadTargets} />
        ) : null}
        {!targets.loading && !targets.error && !showTask ? (
          <EmptyState
            icon={VideoAdd}
            title="Link a class to a course first"
            body="A recording belongs to a class you hosted that is linked to a course. Once you host one, it appears here."
            action={
              <Link className="rup-link rup-link--strong" to={classesPath(root)}>
                Open Classes
              </Link>
            }
          />
        ) : null}
        {showTask ? (
          <>
            <div className="rup-step">
              <Select id="rup-class" labelText="Class" value={sessionId} disabled={busy} onChange={(event) => setSessionId(event.target.value)}>
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
            </div>
            <RecordingDropZone file={file} disabled={busy} onFile={onFile} />
            {fileProblem ? <PageNotification kind="error" title="Not a recording" subtitle={fileProblem} /> : null}
            {matchesResume && flow.phase === "idle" ? <p className="rup-muted">This is the unfinished upload: only the missing parts are sent.</p> : null}
            {flow.phase !== "done" ? <UploadProgress progress={flow.progress} chunkBytes={flow.upload?.chunk_bytes} /> : null}
            <div className="rup-actions">
              {!busy && flow.phase !== "done" ? (
                <Button
                  kind="primary"
                  size="lg"
                  className="sc-button--accent rup-accent"
                  renderIcon={Upload}
                  disabled={!file || !sessionId}
                  aria-describedby={!file || !sessionId ? "rup-upload-reason" : undefined}
                  onClick={() => file && sessionId && flow.start({ sessionId: Number(sessionId), file })}
                >
                  {matchesResume ? "Resume upload" : "Upload"}
                </Button>
              ) : null}
              {!busy && flow.phase !== "done" && (!file || !sessionId) ? (
                <p id="rup-upload-reason" className="rup-muted rup-reason">
                  {!sessionId ? "Choose a class first." : "Choose the recording file first."}
                </p>
              ) : null}
              {flow.phase === "uploading" || flow.phase === "retrying" ? (
                <Button kind="secondary" size="lg" renderIcon={Pause} onClick={flow.pause}>
                  Pause
                </Button>
              ) : null}
              {flow.phase === "paused" ? (
                <Button kind="secondary" size="lg" renderIcon={Play} onClick={flow.resume}>
                  Resume
                </Button>
              ) : null}
              {ACTIVE_PHASES.has(flow.phase) ? (
                <Button kind="danger--ghost" size="lg" renderIcon={StopFilledAlt} onClick={flow.cancel}>
                  Cancel upload
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
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

      <DesktopUploaderSection
        autoOpen={activeTokens > 0 || Boolean(tokenState.created) || flow.phase === "done"}
        activeCount={activeTokens}
        tokens={tokenState.items}
        loading={tokenState.loading}
        error={tokenState.error}
        created={tokenState.created}
        busy={tokenState.busy}
        onCreate={createToken}
        onRevoke={revokeToken}
        onReload={loadTokens}
      />

      <RecentUploads items={recent} />
    </T4Form>
  );
}
