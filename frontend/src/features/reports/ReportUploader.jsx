import { CheckmarkFilled, CloudUpload, ErrorFilled, Renew, TrashCan } from "@carbon/icons-react";
import { Button, InlineNotification } from "@carbon/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { fileTypeIcon } from "./FilePreview";
import { removeReportUpload, uploadReportFile } from "./reportsApi";
import { acceptAttribute, describeExtensions, fileExtension, formatBytes, validatePickedFiles } from "./reportModel";

let nextKey = 1;
const newKey = () => `upload-${nextKey++}`;

function serverItem(file, origin) {
  return {
    key: `${origin}-${file.id}`,
    origin,
    id: file.id,
    name: file.name,
    size: file.size,
    extension: file.extension,
    preview: file.preview,
    status: "done",
    progress: 1,
    error: "",
    file: null,
  };
}

/** Builds the starting list: files kept from the current version, then staged uploads. */
export function initialUploadItems(task, { includeCurrent = false } = {}) {
  const current = includeCurrent ? task?.submission?.current_version?.files || [] : [];
  const staged = task?.staged_files || [];
  return [...current.map((file) => serverItem(file, "current")), ...staged.map((file) => serverItem(file, "staged"))];
}

/**
 * Upload queue for one task: per-file progress, retry, remove (aborting an
 * upload in flight or deleting a staged file on the server).
 */
export function useReportUploads(task, { includeCurrent = false } = {}) {
  const taskId = task?.id;
  const [items, setItems] = useState(() => initialUploadItems(task, { includeCurrent }));
  const [rejections, setRejections] = useState([]);
  const controllers = useRef(new Map());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const active = controllers.current;
    return () => {
      mounted.current = false;
      active.forEach((controller) => controller.abort());
    };
  }, []);

  const patch = useCallback((key, changes) => {
    if (!mounted.current) return;
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  }, []);

  const start = useCallback(
    (item) => {
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      patch(item.key, { status: "uploading", progress: 0, error: "" });
      uploadReportFile(taskId, item.file, {
        signal: controller.signal,
        onProgress: (progress) => patch(item.key, { progress }),
      })
        .then((response) => {
          const stored = apiData(response, {});
          patch(item.key, {
            status: "done",
            progress: 1,
            id: stored.id,
            extension: stored.extension || item.extension,
            preview: stored.preview,
            origin: "staged",
          });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          patch(item.key, { status: "error", error: apiMessage(error, "Upload failed. Check your connection and retry.") });
        })
        .finally(() => controllers.current.delete(item.key));
    },
    [patch, taskId]
  );

  const addFiles = useCallback(
    (fileList, rules) => {
      const existing = items.filter((item) => item.status !== "error");
      const { accepted, rejected } = validatePickedFiles(fileList, rules, existing);
      setRejections(rejected.map((entry) => ({ name: entry.name, reason: entry.reason })));
      const created = accepted.map((file) => ({
        key: newKey(),
        origin: "local",
        id: null,
        name: file.name,
        size: file.size,
        extension: fileExtension(file.name),
        preview: "none",
        status: "queued",
        progress: 0,
        error: "",
        file,
      }));
      if (created.length) {
        setItems((current) => [...current, ...created]);
        created.forEach(start);
      }
      return { accepted: created.length, rejected: rejected.length };
    },
    [items, start]
  );

  const retry = useCallback(
    (key) => {
      const item = items.find((entry) => entry.key === key);
      if (item?.file) start(item);
    },
    [items, start]
  );

  const remove = useCallback(
    (key) => {
      const item = items.find((entry) => entry.key === key);
      if (!item) return;
      controllers.current.get(key)?.abort();
      setItems((current) => current.filter((entry) => entry.key !== key));
      if (item.status === "done" && item.origin === "staged" && item.id) {
        removeReportUpload(taskId, item.id).catch(() => {
          // Already gone or expired: staged files are pruned by the server anyway.
        });
      }
    },
    [items, taskId]
  );

  const reset = useCallback(
    (nextTask, options = {}) => {
      controllers.current.forEach((controller) => controller.abort());
      controllers.current.clear();
      setItems(initialUploadItems(nextTask, options));
      setRejections([]);
    },
    []
  );

  const fileIds = useMemo(() => items.filter((item) => item.status === "done" && item.id).map((item) => item.id), [items]);
  const busy = items.some((item) => item.status === "uploading" || item.status === "queued");
  const failed = items.some((item) => item.status === "error");

  return {
    items,
    rejections,
    dismissRejections: () => setRejections([]),
    addFiles,
    retry,
    remove,
    reset,
    fileIds,
    busy,
    failed,
  };
}

function UploadRow({ item, onRetry, onRemove, disabled }) {
  const Icon = fileTypeIcon(item.extension);
  const percent = Math.round((item.progress || 0) * 100);
  let statusText = "Ready";
  if (item.origin === "current" && item.status === "done") statusText = "From your last version";
  else if (item.status === "uploading") statusText = `Uploading… ${percent}%`;
  else if (item.status === "queued") statusText = "Waiting…";
  else if (item.status === "error") statusText = item.error;
  else statusText = "Uploaded";
  return (
    <li className={`rpt-upload rpt-upload--${item.status}`}>
      <span className="rpt-file__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="rpt-upload__text">
        <span className="rpt-file__name" title={item.name}>
          {item.name}
        </span>
        <span className="rpt-upload__status" role={item.status === "error" ? "alert" : undefined}>
          {item.status === "done" ? <CheckmarkFilled size={16} aria-hidden="true" className="rpt-upload__ok" /> : null}
          {item.status === "error" ? <ErrorFilled size={16} aria-hidden="true" className="rpt-upload__bad" /> : null}
          <span>
            {formatBytes(item.size)} · {statusText}
          </span>
        </span>
        {item.status === "uploading" || item.status === "queued" ? (
          <span
            className="rpt-upload__bar"
            role="progressbar"
            aria-label={`Uploading ${item.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="rpt-upload__fill" style={{ inlineSize: `${percent}%` }} />
          </span>
        ) : null}
      </span>
      <span className="rpt-file__actions">
        {item.status === "error" && item.file ? (
          <Button kind="ghost" size="sm" renderIcon={Renew} onClick={() => onRetry(item.key)} disabled={disabled}>
            Retry
          </Button>
        ) : null}
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={TrashCan}
          iconDescription={item.status === "uploading" ? `Cancel ${item.name}` : `Remove ${item.name}`}
          tooltipPosition="left"
          onClick={() => onRemove(item.key)}
          disabled={disabled}
        />
      </span>
    </li>
  );
}

/** Drag-and-drop or tap-to-pick uploader (presentational; state from useReportUploads). */
export function ReportUploaderView({
  items = [],
  rules = {},
  rejections = [],
  onPick,
  onRetry,
  onRemove,
  onDismissRejections,
  disabled = false,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const inputId = `rpt-file-input-${useId().replace(/:/g, "")}`;
  const extensions = rules.allowedExtensions || [];
  const maxFiles = Number(rules.maxFiles) || 5;
  const remaining = Math.max(0, maxFiles - items.filter((item) => item.status !== "error").length);
  const hint = `${describeExtensions(extensions.length ? extensions : undefined)} · up to ${maxFiles} file${maxFiles === 1 ? "" : "s"}, ${rules.maxFileSizeMb || 50} MB each`;

  const pick = (files) => {
    if (disabled || !files?.length) return;
    onPick(files);
  };

  return (
    <div className="rpt-uploader">
      <div
        className={`rpt-dropzone${dragging ? " rpt-dropzone--active" : ""}${disabled || remaining === 0 ? " rpt-dropzone--disabled" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          pick(event.dataTransfer?.files);
        }}
      >
        <CloudUpload size={32} aria-hidden="true" className="rpt-dropzone__icon" />
        <p className="rpt-dropzone__title">
          <span className="rpt-dropzone__desktop">Drag files here or </span>
          <span className="rpt-dropzone__phone">Add your report files</span>
        </p>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          className="rpt-visually-hidden"
          accept={acceptAttribute(extensions.length ? extensions : undefined)}
          disabled={disabled || remaining === 0}
          onChange={(event) => {
            pick(event.target.files);
            event.target.value = "";
          }}
        />
        <Button
          kind="secondary"
          size="md"
          renderIcon={CloudUpload}
          disabled={disabled || remaining === 0}
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>
        <p className="rpt-dropzone__hint">{remaining === 0 ? `File limit reached (${maxFiles}). Remove one to add another.` : hint}</p>
      </div>

      {rejections.length ? (
        <InlineNotification
          className="rpt-uploader__rejections"
          kind="error"
          lowContrast
          role="alert"
          title={rejections.length === 1 ? "1 file wasn't added" : `${rejections.length} files weren't added`}
          onClose={() => {
            onDismissRejections?.();
            return false;
          }}
        >
          <ul>
            {rejections.map((entry, index) => (
              <li key={`${entry.name}-${index}`}>
                <strong>{entry.name}</strong>: {entry.reason}
              </li>
            ))}
          </ul>
        </InlineNotification>
      ) : null}

      {items.length ? (
        <ul className="rpt-files rpt-uploads" aria-label="Files for this submission">
          {items.map((item) => (
            <UploadRow key={item.key} item={item} onRetry={onRetry} onRemove={onRemove} disabled={disabled} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
