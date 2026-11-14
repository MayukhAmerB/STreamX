import { Add, ArrowRight, CloudUpload, Launch, TrashCan, Undo } from "@carbon/icons-react";
import { Button, InlineLoading, InlineNotification, RadioButton, RadioButtonGroup, TextArea, TextInput } from "@carbon/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { createTarget, getTarget, newIdempotencyKey, removeTargetFile, submitTarget, undoTarget, uploadTargetFile } from "./reportsApi";
import { acceptAttribute, describeExtensions, formatBytes, formatIst, validatePickedFiles } from "./reportModel";
import StatusChip from "./StatusChip";
import {
  UNDO_MS,
  fileRows,
  fileStateLabel,
  findExistingTarget,
  readTargetConflict,
  slotsText,
  submitBlockReason,
  weekChoices,
  weekStatusText,
} from "./weeklyModel";

const POLL_MS = 2000;
const POLL_LIMIT = 90;
let localKey = 1;

/**
 * A Carbon InlineNotification with its action buttons rendered beside it.
 * Carbon notifications must not contain interactive children: they throw
 * "component should have no interactive child nodes" and blank the app.
 */
export function NoticeWithActions({ kind, title, subtitle, children }) {
  return (
    <div className="rpt-weekly__notice">
      <InlineNotification kind={kind} lowContrast hideCloseButton title={title} subtitle={subtitle} />
      <div className="rpt-weekly__notice-actions">{children}</div>
    </div>
  );
}

/** The student's targets for one week, each with its status and an Open action. */
function TargetList({ week, onOpen, openId }) {
  if (!week?.targets?.length) return <p className="rpt-muted">No reports yet for {week?.label || "this week"}.</p>;
  return (
    <ul className="rpt-rows" aria-label={`Your reports for ${week.label}`}>
      {week.targets.map((target) => (
        <li key={target.id}>
          <button type="button" className="rpt-row" aria-current={openId === target.id ? "true" : undefined} onClick={() => onOpen(target.id)}>
            <span className="rpt-row__text">
              <span className="rpt-row__title">{target.target_name}</span>
              <span className="rpt-row__meta">
                {target.submitted_at ? `Sent ${formatIst(target.submitted_at)}` : "Draft, not sent yet"}
                {target.file_count ? ` · ${target.file_count} file${target.file_count === 1 ? "" : "s"}` : ""}
              </span>
            </span>
            <StatusChip item={target} size="sm" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Presentational card (tests and the screenshot harness render it directly):
 * week, due time, late status, existing reports, and one form with target
 * name -> files -> Submit.
 */
export function WeeklyReportView({
  state,
  now = Date.now(),
  which = "current",
  onWhich,
  targetName = "",
  onTargetName,
  target = null,
  files = [],
  note = "",
  onNote,
  conflict = null,
  onConfirmDifferent,
  onOpenTarget,
  onPickFiles,
  onRemoveFile,
  onSubmit,
  onNewTarget,
  submitting = false,
  error = "",
  undo = null,
  onUndo,
  busy = false,
}) {
  const inputId = useId();
  const fileInput = useRef(null);
  const weeks = state?.weeks || [];
  const week = weeks.find((item) => item.which === which) || weeks[0] || null;
  const rules = state?.rules || {};
  const enabled = Boolean(state?.enabled);
  const reason = submitBlockReason({
    enabled,
    disabledReason: state?.reason,
    targetName: target ? target.target_name : targetName,
    files,
    busy: busy || submitting,
    canChange: target ? target.can_change : true,
    lockReason: target?.lock_reason,
  });
  const choices = weekChoices(weeks);
  const existing = !target ? findExistingTarget(targetName, week?.targets || []) : null;
  const titleId = `${inputId}-title`;

  return (
    <section className="rpt-hero rpt-weekly" aria-labelledby={titleId} data-course={state?.course?.id}>
      <p className="rpt-eyebrow">{state?.course?.title}</p>
      <h2 id={titleId} className="rpt-hero__title">
        {target ? `Your report: ${target.target_name}` : "Submit this week's report"}
      </h2>

      {!enabled ? (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Weekly reports are off." subtitle={state?.reason || "Reports are not enabled for this course."} />
      ) : null}

      {enabled && week ? (
        <div className="rpt-weekly__week">
          <p className="rpt-hero__meta">
            <strong>{week.label}</strong>
          </p>
          <p className={`rpt-hero__due${week.status === "late" ? " rpt-weekly__late" : ""}`}>{weekStatusText(week, now)}</p>
          {slotsText(week) ? <p className="rpt-muted">{slotsText(week)}</p> : null}
        </div>
      ) : null}

      {enabled && choices.length > 1 && !target ? (
        <RadioButtonGroup legendText="Which week is this report for?" name={`${inputId}-week`} valueSelected={which} onChange={(value) => onWhich?.(value)}>
          {choices.map((choice) => (
            <RadioButton key={choice.value} id={`${inputId}-${choice.value}`} labelText={choice.label} value={choice.value} />
          ))}
        </RadioButtonGroup>
      ) : null}

      {undo ? (
        <NoticeWithActions kind="success" title="Report submitted." subtitle={undo.message || "You'll get a receipt in your notifications."}>
          <Button kind="ghost" size="sm" renderIcon={Undo} onClick={onUndo}>
            Undo
          </Button>
        </NoticeWithActions>
      ) : null}

      {enabled ? (
        <form
          className="rpt-weekly__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason) onSubmit?.();
          }}
        >
          {target ? (
            <p className="rpt-muted">
              <StatusChip item={target} size="sm" /> {target.submitted_at ? `Last sent ${formatIst(target.submitted_at)}` : "Not sent yet"}
              {target.lock_reason ? ` · ${target.lock_reason}` : ""}
            </p>
          ) : (
            <TextInput
              id={`${inputId}-target`}
              labelText="Target name"
              helperText="The person or company you investigated, e.g. Acme Pvt Ltd."
              value={targetName}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => onTargetName?.(event.target.value)}
            />
          )}

          {existing ? (
            <NoticeWithActions kind="info" title={`You already have a report for “${existing.target_name}”.`} subtitle="Open it to change its files.">
              <Button kind="ghost" size="sm" renderIcon={Launch} onClick={() => onOpenTarget?.(existing.id)}>
                Open existing
              </Button>
            </NoticeWithActions>
          ) : null}

          {conflict ? (
            <NoticeWithActions kind="warning" title={conflict.message || "Check the target name."}>
              {conflict.existing ? (
                <Button kind="ghost" size="sm" renderIcon={Launch} onClick={() => onOpenTarget?.(conflict.existing.id)}>
                  Open existing
                </Button>
              ) : null}
              {conflict.suggestions?.map((item) => (
                <Button key={item.id} kind="ghost" size="sm" renderIcon={Launch} onClick={() => onOpenTarget?.(item.id)}>
                  Open “{item.target_name}”
                </Button>
              ))}
              {conflict.code === "similar_target" ? (
                <Button kind="tertiary" size="sm" onClick={onConfirmDifferent}>
                  It's a different target
                </Button>
              ) : null}
            </NoticeWithActions>
          ) : null}

          <div className="rpt-weekly__files">
            <input
              ref={fileInput}
              id={`${inputId}-file`}
              type="file"
              multiple
              hidden
              accept={acceptAttribute(rules.allowed_extensions)}
              onChange={(event) => {
                onPickFiles?.(Array.from(event.target.files || []));
                event.target.value = "";
              }}
            />
            <Button
              kind="tertiary"
              size="md"
              renderIcon={CloudUpload}
              disabled={Boolean(target && !target.can_change)}
              onClick={() => fileInput.current?.click()}
            >
              Add files
            </Button>
            <p className="rpt-muted">
              {describeExtensions(rules.allowed_extensions)} · up to {rules.max_files || 5} files, {rules.max_file_size_mb || 50} MB each. Files are checked for viruses.
            </p>
            {files.length ? (
              <ul className="rpt-weekly__file-list" aria-label="Files for this report">
                {files.map((file) => (
                  <li key={file.key || file.id} className="rpt-weekly__file" data-state={file.scan_status || file.status}>
                    <span className="rpt-row__title">{file.name}</span>
                    <span className="rpt-muted">
                      {file.size ? formatBytes(file.size) : ""} · {fileStateLabel(file)}
                    </span>
                    {file.id && (!target || target.can_change) ? (
                      <Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription={`Remove ${file.name}`} onClick={() => onRemoveFile?.(file)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {target?.current_version?.files?.length ? (
              <p className="rpt-muted">
                Already sent: {target.current_version.files.map((file) => file.name).join(", ")}. New files are added to them.
              </p>
            ) : null}
          </div>

          <TextArea id={`${inputId}-note`} labelText="Note for your instructor (optional)" rows={2} maxCount={2000} enableCounter value={note} onChange={(event) => onNote?.(event.target.value)} />

          {error ? <InlineNotification kind="error" lowContrast hideCloseButton title="Not submitted." subtitle={error} /> : null}

          <div className="rpt-weekly__actions">
            <Button type="submit" kind="primary" renderIcon={ArrowRight} disabled={Boolean(reason)} aria-describedby={reason ? `${inputId}-reason` : undefined}>
              {submitting ? "Submitting…" : target?.version_count ? "Send updated report" : "Submit report"}
            </Button>
            {target ? (
              <Button kind="ghost" renderIcon={Add} onClick={onNewTarget}>
                Report another target
              </Button>
            ) : null}
            {submitting ? <InlineLoading description="Submitting…" /> : null}
          </div>
          {reason ? (
            <p id={`${inputId}-reason`} className="rpt-muted rpt-weekly__reason" role="status">
              {reason}
            </p>
          ) : null}
        </form>
      ) : null}

      {enabled && week ? (
        <div className="rpt-weekly__existing">
          <h3 className="cds-section-title">Your reports this week</h3>
          <TargetList week={week} onOpen={onOpenTarget} openId={target?.id} />
        </div>
      ) : null}
    </section>
  );
}

/** Container: talks to /api/reports/me/... for one course. */
export default function WeeklyReportCard({ state, now, onChanged, notify }) {
  const courseId = state?.course?.id;
  const [which, setWhich] = useState("current");
  const [targetName, setTargetName] = useState("");
  const [target, setTarget] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState(null);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState(null);
  const submitKey = useRef(newIdempotencyKey());
  const polls = useRef(0);

  const loadTarget = useCallback((id) => getTarget(id).then((response) => {
    const data = apiData(response, null);
    setTarget(data);
    return data;
  }), []);

  // Poll while a file is still being virus-scanned.
  const scanning = (target?.draft_files || []).some((file) => file.scan_pending);
  useEffect(() => {
    if (!scanning || !target?.id) {
      polls.current = 0;
      return undefined;
    }
    if (polls.current >= POLL_LIMIT) return undefined;
    const timer = setTimeout(() => {
      polls.current += 1;
      loadTarget(target.id).catch(() => {});
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [scanning, target, loadTarget]);

  const uploadAll = useCallback(
    (targetId, picked) => {
      const items = picked.map((file) => ({ key: `local-${localKey++}`, name: file.name, size: file.size, status: "uploading", progress: 0, file }));
      setUploads((current) => [...current, ...items]);
      return Promise.all(
        items.map((item) =>
          uploadTargetFile(targetId, item.file, {
            onProgress: (progress) => setUploads((current) => current.map((entry) => (entry.key === item.key ? { ...entry, progress } : entry))),
          })
            .then(() => setUploads((current) => current.filter((entry) => entry.key !== item.key)))
            .catch((uploadError) =>
              setUploads((current) =>
                current.map((entry) => (entry.key === item.key ? { ...entry, status: "error", error: apiMessage(uploadError, "Upload failed. Try again.") } : entry))
              )
            )
        )
      ).then(() => loadTarget(targetId));
    },
    [loadTarget]
  );

  const ensureTarget = useCallback(
    (confirmDifferent = false) => {
      if (target) return Promise.resolve(target);
      setConflict(null);
      return createTarget({ courseId, targetName, week: which, confirmDifferent }).then((response) => {
        const data = apiData(response, null);
        setTarget(data);
        onChanged?.();
        return data;
      });
    },
    [target, courseId, targetName, which, onChanged]
  );

  const pickFiles = (picked) => {
    const source = target?.rules || state?.rules || {};
    const rules = {
      allowedExtensions: source.allowed_extensions,
      maxFiles: source.max_files,
      maxFileSizeMb: source.max_file_size_mb,
      maxTotalSizeMb: source.max_total_size_mb,
    };
    const { accepted, rejected } = validatePickedFiles(picked, rules, fileRows(target, uploads));
    if (rejected.length) setError(rejected.map((entry) => `${entry.name}: ${entry.reason}`).join(" "));
    else setError("");
    if (!accepted.length) return;
    setBusy(true);
    ensureTarget()
      .then((created) => uploadAll(created.id, accepted))
      .catch((createError) => {
        const parsed = readTargetConflict(createError);
        if (parsed) {
          setConflict(parsed);
          setPending(accepted);
        } else setError(apiMessage(createError, "Couldn't start your report. Try again."));
      })
      .finally(() => setBusy(false));
  };

  const confirmDifferent = () => {
    setBusy(true);
    ensureTarget(true)
      .then((created) => {
        setConflict(null);
        const queued = pending;
        setPending([]);
        return queued.length ? uploadAll(created.id, queued) : null;
      })
      .catch((createError) => setConflict(readTargetConflict(createError) || { message: apiMessage(createError, "Try again.") }))
      .finally(() => setBusy(false));
  };

  const openTarget = (id) => {
    setConflict(null);
    setPending([]);
    setUploads([]);
    setError("");
    loadTarget(id).catch((loadError) => setError(apiMessage(loadError, "Couldn't open that report.")));
  };

  const reset = () => {
    setTarget(null);
    setTargetName("");
    setUploads([]);
    setNote("");
    setConflict(null);
    setPending([]);
    setError("");
    submitKey.current = newIdempotencyKey();
  };

  const removeFile = (file) => {
    if (!target?.id || !file.id) {
      setUploads((current) => current.filter((entry) => entry.key !== file.key));
      return;
    }
    removeTargetFile(target.id, file.id)
      .then(() => loadTarget(target.id))
      .catch((removeError) => setError(apiMessage(removeError, "Couldn't remove that file.")));
  };

  const submit = () => {
    if (!target) return;
    setSubmitting(true);
    setError("");
    submitTarget(target.id, { note }, submitKey.current)
      .then((response) => {
        const data = apiData(response, {});
        const submittedId = target.id;
        setTarget(data.target || null);
        submitKey.current = newIdempotencyKey();
        onChanged?.();
        if (data.target?.undo_until) {
          setUndo({ id: submittedId, message: "You can undo this for 10 seconds." });
          setTimeout(() => setUndo((current) => (current?.id === submittedId ? null : current)), UNDO_MS);
        } else {
          notify?.({ kind: "success", title: response?.data?.message || "Report submitted." });
        }
      })
      .catch((submitError) => setError(apiMessage(submitError, "Not submitted. Try again.")))
      .finally(() => setSubmitting(false));
  };

  const undoSubmit = () => {
    if (!undo) return;
    undoTarget(undo.id)
      .then((response) => {
        setTarget(apiData(response, null));
        setUndo(null);
        onChanged?.();
      })
      .catch((undoError) => {
        setUndo(null);
        setError(apiMessage(undoError, "It's too late to undo."));
      });
  };

  return (
    <WeeklyReportView
      state={state}
      now={now}
      which={which}
      onWhich={setWhich}
      targetName={targetName}
      onTargetName={(value) => {
        setTargetName(value);
        setConflict(null);
      }}
      target={target}
      files={fileRows(target, uploads)}
      note={note}
      onNote={setNote}
      conflict={conflict}
      onConfirmDifferent={confirmDifferent}
      onOpenTarget={openTarget}
      onPickFiles={pickFiles}
      onRemoveFile={removeFile}
      onSubmit={submit}
      onNewTarget={reset}
      submitting={submitting}
      busy={busy}
      error={error}
      undo={undo}
      onUndo={undoSubmit}
    />
  );
}
