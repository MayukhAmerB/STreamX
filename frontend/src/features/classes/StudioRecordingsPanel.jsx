// Studio "Recordings" tab: the automatic class recording (state, module,
// retry, admin re-run) and, for browser classes, the latest recording.
// Uses the state rules of ClassRecordingStatus. OWNER: WS-D1.
import { ArrowRight, Launch } from "@carbon/icons-react";
import { Button, InlineNotification, Select, SelectItem } from "@carbon/react";
import { Link } from "react-router-dom";
import {
  AUTO_MODULE_TITLE,
  canRerunFinalize,
  describeClassRecording,
} from "../../components/realtime/ClassRecordingStatus";
import { confirmCopy, resolveRecordingPlaybackUrl } from "./classesModel";

const SOURCE_LABELS = {
  server: "Server recording",
  obs_upload: "OBS upload",
  livekit_egress: "Meeting recording",
  imported: "Imported recording",
  browser_fallback: "Browser recording",
};

const TONE_TO_PILL = { live: "bad", busy: "warn", done: "good", failed: "bad" };

function ModulePicker({ recording, options, onChange, changing }) {
  const currentId = recording?.module?.id ?? "";
  const known = options.some((option) => option.id === currentId);
  return (
    <Select
      id={`cls-recording-module-${recording.id}`}
      labelText="Module"
      size="sm"
      value={currentId === "" ? "" : String(currentId)}
      disabled={changing || recording.can_choose_module === false}
      helperText={recording.can_choose_module === false ? "The recording is being saved; try again in a moment." : ""}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (next && next !== currentId) onChange(recording, next);
      }}
    >
      {currentId === "" ? <SelectItem value="" text="Choose automatically" /> : null}
      {currentId !== "" && !known ? <SelectItem value={String(currentId)} text={recording.module?.title || "Current module"} /> : null}
      {options.map((option) => (
        <SelectItem key={option.id} value={String(option.id)} text={option.title} />
      ))}
    </Select>
  );
}

export default function StudioRecordingsPanel({ session, recordings, browserMode, isAdmin, uploadHref, confirm }) {
  const { classRecordings, classState, moduleOptions, actionId, changeModule, rerun, retry, latest, deleteLatest } = recordings;
  const moduleTitle = String(session?.target_module?.title || "").trim();
  const rows = classRecordings.slice(0, 3);
  const playbackUrl = resolveRecordingPlaybackUrl(latest.latestCompleted);

  const onDeleteLatest = async () => {
    if (await confirm(confirmCopy("delete-recording", session))) await deleteLatest();
  };

  return (
    <div className="cls-panel-stack">
      <section className="cls-section" aria-labelledby="cls-rec-title">
        <h2 id="cls-rec-title" className="cls-section__title">
          Class recording
        </h2>
        <p className="cls-help">
          {moduleTitle
            ? `Recorded automatically and published to ${moduleTitle} when the class ends.`
            : `Recorded automatically. With no module chosen it goes to “${AUTO_MODULE_TITLE}” and an admin is asked to review it.`}
        </p>
        {rows.length ? (
          <ul className="cls-messages" aria-label="Class recordings">
            {rows.map((recording) => {
              const { tone, label } = describeClassRecording(recording);
              const lectureTitle = String(recording?.lecture?.title || "").trim();
              return (
                <li key={recording.id} className="cls-message">
                  <span className={`cls-pill cls-pill--${TONE_TO_PILL[tone] || "idle"}`} role={tone === "failed" ? "alert" : undefined}>
                    <span className="cls-pill__dot" aria-hidden="true" />
                    {label}
                  </span>
                  <p className="cls-help">
                    {SOURCE_LABELS[recording.source] || recording.source}
                    {lectureTitle ? ` · Lecture: ${lectureTitle}` : ""}
                  </p>
                  {recording.needs_review ? (
                    <p className="cls-help cls-warning">Needs review{recording.review_reason ? `: ${recording.review_reason}` : ""}</p>
                  ) : null}
                  <div className="cls-card__actions">
                    {changeModule && moduleOptions.length ? (
                      <ModulePicker recording={recording} options={moduleOptions} onChange={changeModule} changing={actionId.module === recording.id} />
                    ) : null}
                    {recording.state === "failed" && recording.can_retry ? (
                      <Button kind="tertiary" size="sm" disabled={classState.retryingId === recording.id} onClick={() => retry(recording)}>
                        Retry
                      </Button>
                    ) : null}
                    {isAdmin && canRerunFinalize(recording) ? (
                      <Button kind="ghost" size="sm" disabled={actionId.rerun === recording.id} onClick={() => rerun(recording)}>
                        Re-run finalize
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="cls-help">{classState.loading ? "Checking…" : "Nothing yet. It starts by itself when the class goes live."}</p>
        )}
        {classState.error ? <InlineNotification lowContrast kind="error" title="Recording" subtitle={classState.error} hideCloseButton /> : null}
      </section>
      {browserMode ? (
        <section className="cls-section" aria-labelledby="cls-rec-latest">
          <h3 id="cls-rec-latest" className="cls-section__subtitle">
            Latest browser take
          </h3>
          {latest.error ? <InlineNotification lowContrast kind="error" title="Recording" subtitle={latest.error} hideCloseButton /> : null}
          {latest.info ? <p className="cls-help" role="status">{latest.info}</p> : null}
          <div className="cls-card__actions">
            {playbackUrl ? (
              <a className="cls-text-link" href={playbackUrl} target="_blank" rel="noreferrer">
                Open the last take <Launch size={16} aria-hidden="true" />
              </a>
            ) : (
              <p className="cls-help">No finished take yet.</p>
            )}
            <Button
              kind="danger--ghost"
              size="sm"
              disabled={latest.loading || !latest.latestCompleted?.id || Boolean(latest.active)}
              onClick={onDeleteLatest}
            >
              Delete last take
            </Button>
          </div>
        </section>
      ) : null}
      {uploadHref ? (
        <Link className="cls-text-link" to={uploadHref}>
          Upload a better copy from OBS <ArrowRight size={16} aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}
