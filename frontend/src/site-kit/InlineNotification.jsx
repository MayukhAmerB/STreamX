import { useId } from "react";

import Button from "./Button";
import { CloseIcon, StatusIcon } from "./icons";
import { cx } from "./utils";

const KINDS = ["error", "warning", "info", "success"];

/** "hh:mm" in the visitor's locale, or "" for an invalid time. */
export function formatClockTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Inline status message (plan §7.2 rule 7). Errors and warnings are
 * announced (role="alert"), info and success politely (role="status").
 *
 * - onRetry adds a Retry button (busy while `retrying`).
 * - lastUpdated shows "Last updated hh:mm" when cached data is still shown.
 * - action: one extra element (e.g. a "Join now" link).
 * - onClose adds a dismiss button.
 */
export default function InlineNotification({
  kind = "info",
  title,
  subtitle,
  children,
  onRetry,
  retrying = false,
  retryLabel = "Retry",
  lastUpdated,
  action,
  onClose,
  lowContrast = false,
  className,
  ...rest
}) {
  const titleId = useId();
  const safeKind = KINDS.includes(kind) ? kind : "info";
  const urgent = safeKind === "error" || safeKind === "warning";
  const updated = lastUpdated ? formatClockTime(lastUpdated) : "";
  return (
    <div
      role={urgent ? "alert" : "status"}
      aria-labelledby={title ? titleId : undefined}
      className={cx("sk-notification", `sk-notification--${safeKind}`, lowContrast && "sk-notification--low-contrast", className)}
      {...rest}
    >
      <StatusIcon kind={safeKind} className="sk-notification__icon" />
      <div className="sk-notification__text">
        {title ? (
          <p id={titleId} className="sk-notification__title">
            {title}
          </p>
        ) : null}
        {subtitle || children ? <div className="sk-notification__subtitle">{subtitle ?? children}</div> : null}
        {updated ? <p className="sk-notification__meta">Last updated {updated}</p> : null}
      </div>
      {onRetry || action ? (
        <div className="sk-notification__actions">
          {action}
          {onRetry ? (
            <Button kind="ghost" size="md" loading={retrying} loadingText="Retrying" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {onClose ? (
        <button type="button" className="sk-notification__close" aria-label="Dismiss notification" onClick={onClose}>
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}
