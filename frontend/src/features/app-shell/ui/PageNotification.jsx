import { Renew } from "@carbon/icons-react";
import { Button, InlineNotification } from "@carbon/react";

/**
 * Inline page message (error / warning / info / success). Pass `actionLabel`
 * + `onAction` for a one-tap recovery such as "Try again"; focus is not
 * moved, so the message never interrupts the user.
 */
export default function PageNotification({ kind = "error", title, subtitle, actionLabel, onAction, onClose }) {
  const notification = (
    <InlineNotification
      className="cds-page-notification"
      lowContrast
      kind={kind}
      title={title}
      subtitle={subtitle}
      role={kind === "error" ? "alert" : "status"}
      hideCloseButton={!onClose}
      onClose={onClose}
    />
  );

  if (!actionLabel || !onAction) return notification;

  return (
    <div className="cds-page-notification-group">
      {notification}
      <Button kind="tertiary" renderIcon={Renew} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}
