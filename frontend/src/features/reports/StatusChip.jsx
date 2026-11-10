import {
  Checkmark,
  CheckmarkFilled,
  ErrorFilled,
  InProgress,
  Time,
  Undo,
  WarningAltFilled,
} from "@carbon/icons-react";
import { getStatusChip } from "./reportModel";

export const STATUS_ICONS = {
  graded: CheckmarkFilled,
  submitted: Checkmark,
  late: WarningAltFilled,
  returned: Undo,
  review: InProgress,
  missing: ErrorFilled,
  pending: Time,
};

/** Status chip: icon + label (never colour alone). `chip` overrides the derived one. */
export default function StatusChip({ item, chip, size = "md" }) {
  const resolved = chip || getStatusChip(item);
  const Icon = STATUS_ICONS[resolved.icon] || Time;
  return (
    <span className={`rpt-chip rpt-chip--${resolved.tone} rpt-chip--${size}`} data-status={resolved.id}>
      <Icon size={16} aria-hidden="true" className="rpt-chip__icon" />
      <span className="rpt-chip__label">{resolved.label}</span>
    </span>
  );
}

/** Small "Late · 2 h" chip shown next to the main status when relevant. */
export function LateChip({ minutesLate, label }) {
  return (
    <span className="rpt-chip rpt-chip--warning rpt-chip--sm" data-status="late">
      <WarningAltFilled size={16} aria-hidden="true" className="rpt-chip__icon" />
      <span className="rpt-chip__label">{label || "Late"}{minutesLate ? ` · ${minutesLate}` : ""}</span>
    </span>
  );
}
