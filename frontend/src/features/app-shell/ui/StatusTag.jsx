// StatusTag (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// One status vocabulary in sentence case, always an icon (or the live dot)
// and a word, never colour alone. A pill: the second and last shape token.
import { CheckmarkFilled, CircleDash, Edit, ErrorFilled, InProgress, RadioButtonChecked, Time, WarningAltFilled } from "@carbon/icons-react";
import { LiveDot } from "../../../site-kit/motion";
import "./overhaul.scss";

export const STATUS_VOCABULARY = Object.freeze({
  live: { label: "Live", type: "red" },
  open: { label: "Open", type: "green" },
  due: { label: "Due", type: "outline" },
  late: { label: "Late", type: "warm-gray" },
  graded: { label: "Graded", type: "green" },
  draft: { label: "Draft", type: "gray" },
  scheduled: { label: "Scheduled", type: "gray" },
  processing: { label: "Processing", type: "blue" },
  failed: { label: "Failed", type: "red" },
  published: { label: "Published", type: "green" },
  on: { label: "On", type: "green" },
  off: { label: "Off", type: "gray" },
});

// Tone drives the colour; the icon carries the meaning.
const TONES = {
  live: "live",
  open: "success",
  due: "due",
  late: "warning",
  graded: "success",
  draft: "neutral",
  scheduled: "neutral",
  processing: "info",
  failed: "error",
  published: "success",
  on: "success",
  off: "neutral",
};

const ICONS = {
  open: RadioButtonChecked,
  due: Time,
  late: WarningAltFilled,
  graded: CheckmarkFilled,
  draft: Edit,
  scheduled: Time,
  processing: InProgress,
  failed: ErrorFilled,
  published: CheckmarkFilled,
  on: CheckmarkFilled,
  off: CircleDash,
};

export default function StatusTag({ status, children, className = "" }) {
  const entry = STATUS_VOCABULARY[status] || { label: String(status || ""), type: "gray" };
  const tone = TONES[status] || "neutral";
  const Icon = ICONS[status];
  return (
    <span className={`sc-status-tag sc-status-tag--${tone} ${className}`.trim()} data-status={status}>
      {status === "live" ? <LiveDot state="live" /> : Icon ? <Icon size={16} aria-hidden="true" className="sc-status-tag__icon" /> : null}
      <span className="sc-status-tag__label">{children || entry.label}</span>
    </span>
  );
}
