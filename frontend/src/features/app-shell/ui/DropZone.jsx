// DropZone (UI overhaul plan §2.5 and M7b, Appendix A.5). OWNER: WS-A.
// Replaces native file inputs (Exams, Reports, Upload). Drop a file or
// choose one with the keyboard (the real <input> stays focusable). On drag
// the dashed border turns solid white, the fill lightens and the icon lifts
// 4 px (fast-02; colour only under reduced motion). Files over `maxBytes`
// are refused with a sentence that names them; a disabled zone says why.
import { CloudUpload } from "@carbon/icons-react";
import { useId, useRef, useState } from "react";
import "./overhaul.scss";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export default function DropZone({
  accept,
  maxBytes,
  onFiles,
  disabledReason,
  label = "Drop a file here or choose one",
  hint,
  multiple = false,
  icon: Icon = CloudUpload,
}) {
  const inputId = useId();
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState("");
  const depth = useRef(0);
  const disabled = Boolean(disabledReason);

  const take = (fileList) => {
    const files = [...(fileList || [])];
    const tooBig = maxBytes ? files.filter((file) => file.size > maxBytes) : [];
    const ok = files.filter((file) => !tooBig.includes(file));
    setRefused(tooBig.length ? `${tooBig.map((file) => file.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} larger than ${formatBytes(maxBytes)}.` : "");
    if (ok.length) onFiles?.(multiple ? ok : ok.slice(0, 1));
  };

  const describedBy = [disabled ? `${inputId}-reason` : null, hint ? `${inputId}-hint` : null, refused ? `${inputId}-refused` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div
      className={`sc-drop-zone${over ? " is-over" : ""}${disabled ? " is-disabled" : ""}`}
      onDragEnter={(event) => {
        if (disabled) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) take(event.dataTransfer?.files);
      }}
    >
      <Icon size={32} aria-hidden="true" className="sc-drop-zone__icon" />
      <label htmlFor={inputId} className="sc-drop-zone__label">
        <span className="sc-drop-zone__text">{label}</span>
        <span className="sc-drop-zone__choose" aria-hidden="true">
          Choose {multiple ? "files" : "a file"}
        </span>
      </label>
      <input
        id={inputId}
        className="sc-drop-zone__input"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          take(event.target.files);
          if (event.target) event.target.value = "";
        }}
      />
      {hint ? (
        <p id={`${inputId}-hint`} className="sc-drop-zone__hint">
          {hint}
        </p>
      ) : null}
      {disabled ? (
        <p id={`${inputId}-reason`} className="sc-drop-zone__reason">
          {disabledReason}
        </p>
      ) : null}
      {refused ? (
        <p id={`${inputId}-refused`} className="sc-drop-zone__refused" role="alert">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
