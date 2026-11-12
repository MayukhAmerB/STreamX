import {
  Download,
  Document,
  DocumentPdf,
  FolderOpen,
  Image as ImageIcon,
  Launch,
  Notebook,
  Flow,
  PresentationFile,
  View,
} from "@carbon/icons-react";
import { Button, InlineLoading } from "@carbon/react";
import { useEffect, useState } from "react";
import { apiMessage } from "../../utils/api";
import CanvasPreview from "./CanvasPreview";
import Markdown from "./markdown";
import { fetchReportFileText, reportFilePath, reportsHref } from "./reportsApi";
import { formatBytes } from "./reportModel";

const TYPE_ICONS = {
  pdf: DocumentPdf,
  ppt: PresentationFile,
  pptx: PresentationFile,
  odp: PresentationFile,
  md: Notebook,
  canvas: Flow,
  zip: FolderOpen,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  webp: ImageIcon,
  svg: ImageIcon,
};

export function fileTypeIcon(extension) {
  return TYPE_ICONS[String(extension || "").toLowerCase()] || Document;
}

export function fileHref(file, { inline = false } = {}) {
  return reportsHref(reportFilePath(file), inline ? { inline: 1 } : undefined);
}

/** Only files with a clean virus scan can be fetched (the server refuses the rest). */
export function isDownloadable(file) {
  return !file?.scan_status || file.scan_status === "clean";
}

/** Why a file has no preview (shown on its card). */
export function noPreviewReason(file) {
  if (file?.scan_status === "infected") return "Blocked by the virus scanner.";
  if (file?.scan_status && file.scan_status !== "clean") return "Waiting for the virus scan.";
  const ext = String(file?.extension || "").toLowerCase();
  if (ext === "svg") return "SVG files are download-only for safety.";
  if (ext === "zip") return "Vault .zip: download to open it in Obsidian.";
  return "Download to open it.";
}

/** One file row: icon, name, size, Preview + Download. */
export function FileCard({ file, selected = false, onPreview, actions = null }) {
  const Icon = fileTypeIcon(file.extension);
  const canPreview = file.preview && file.preview !== "none";
  return (
    <li className={`rpt-file${selected ? " rpt-file--selected" : ""}`}>
      <span className="rpt-file__icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span className="rpt-file__text">
        <span className="rpt-file__name" title={file.name}>
          {file.name}
        </span>
        <span className="rpt-file__meta">
          {String(file.extension || "").toUpperCase()} · {formatBytes(file.size)}
          {!canPreview ? ` · ${noPreviewReason(file)}` : ""}
        </span>
      </span>
      <span className="rpt-file__actions">
        {canPreview && onPreview ? (
          <Button
            kind={selected ? "secondary" : "ghost"}
            size="sm"
            renderIcon={View}
            onClick={() => onPreview(file)}
            aria-pressed={selected}
            aria-label={`Preview ${file.name}`}
          >
            Preview
          </Button>
        ) : null}
        {isDownloadable(file) ? (
          <Button kind="ghost" size="sm" renderIcon={Download} href={fileHref(file)} aria-label={`Download ${file.name}`}>
            Download
          </Button>
        ) : null}
        {actions}
      </span>
    </li>
  );
}

export function FileList({ files = [], selectedKey, onPreview, label = "Files" }) {
  if (!files.length) return null;
  return (
    <ul className="rpt-files" aria-label={label}>
      {files.map((file) => (
        <FileCard
          key={`${file.source || "submission"}-${file.id}`}
          file={file}
          selected={selectedKey === `${file.source || "submission"}-${file.id}`}
          onPreview={onPreview}
        />
      ))}
    </ul>
  );
}

function TextPreview({ file, render }) {
  const [state, setState] = useState({ key: "", text: "", error: "", loading: true });
  const key = `${file.source || "submission"}-${file.id}`;

  useEffect(() => {
    let cancelled = false;
    fetchReportFileText(file)
      .then((response) => {
        if (!cancelled) setState({ key, text: String(response?.data ?? ""), error: "", loading: false });
      })
      .catch((error) => {
        if (!cancelled) setState({ key, text: "", error: apiMessage(error, "This file could not be loaded."), loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (state.key !== key || state.loading) return <InlineLoading description="Loading preview…" />;
  if (state.error) return <p className="rpt-preview__message">{state.error}</p>;
  return render(state.text);
}

/** Inline preview: PDF and images inline, Markdown rendered safely, canvases drawn. */
export default function FilePreview({ file, onClose }) {
  if (!file) return null;
  const kind = file.preview || "none";
  const inlineHref = fileHref(file, { inline: true });
  let body;
  if (kind === "pdf") {
    body = <iframe className="rpt-preview__frame" src={inlineHref} title={`PDF preview: ${file.name}`} />;
  } else if (kind === "image") {
    body = <img className="rpt-preview__image" src={inlineHref} alt={`Preview of ${file.name}`} loading="lazy" />;
  } else if (kind === "markdown") {
    body = <TextPreview file={file} render={(text) => <Markdown text={text} className="rpt-preview__markdown" />} />;
  } else if (kind === "canvas") {
    body = <TextPreview file={file} render={(text) => <CanvasPreview source={text} title={file.name} />} />;
  } else {
    body = <p className="rpt-preview__message">No preview for this file type. {noPreviewReason(file)}</p>;
  }
  return (
    <section className="rpt-preview" aria-label={`Preview: ${file.name}`}>
      <header className="rpt-preview__header">
        <h3 className="rpt-preview__title" title={file.name}>
          {file.name}
        </h3>
        <span className="rpt-preview__actions">
          {kind === "pdf" || kind === "image" ? (
            <Button kind="ghost" size="sm" renderIcon={Launch} href={inlineHref} target="_blank" rel="noopener noreferrer">
              Open
            </Button>
          ) : null}
          <Button kind="ghost" size="sm" renderIcon={Download} href={fileHref(file)}>
            Download
          </Button>
          {onClose ? (
            <Button kind="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </span>
      </header>
      <div className={`rpt-preview__body rpt-preview__body--${kind}`}>{body}</div>
    </section>
  );
}
