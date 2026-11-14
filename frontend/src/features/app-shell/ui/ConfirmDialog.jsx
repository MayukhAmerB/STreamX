// ConfirmDialog (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// Names the object it acts on ("Delete ‘E2E OBS broadcast’?"), asks for an
// optional or required reason (money and destructive actions), and returns
// focus to whatever opened it. Built on Carbon Modal (its own motion kept).
import { Modal, TextArea } from "@carbon/react";
import { useEffect, useId, useRef, useState } from "react";
import "./overhaul.scss";

export default function ConfirmDialog({
  open,
  title,
  objectName,
  body,
  confirmLabel = "Confirm",
  danger = false,
  reason = "none",
  onConfirm,
  onCancel,
}) {
  const [reasonText, setReasonText] = useState("");
  const [touched, setTouched] = useState(false);
  const reasonId = useId();
  const opener = useRef(null);

  useEffect(() => {
    if (open) {
      opener.current = typeof document !== "undefined" ? document.activeElement : null;
      return undefined;
    }
    setReasonText("");
    setTouched(false);
    const previous = opener.current;
    opener.current = null;
    // Focus returns to the trigger once the dialog has closed.
    if (previous && typeof previous.focus === "function") {
      const timer = setTimeout(() => previous.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  const missingReason = reason === "required" && !reasonText.trim();
  const named = objectName && !String(title || "").includes(objectName);
  return (
    <Modal
      open={Boolean(open)}
      danger={danger}
      modalHeading={title}
      modalLabel={named ? undefined : objectName || undefined}
      primaryButtonText={confirmLabel}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={missingReason}
      onRequestClose={() => onCancel?.()}
      onRequestSubmit={() => {
        setTouched(true);
        if (!missingReason) onConfirm?.(reasonText.trim());
      }}
      size="sm"
      className="sc-confirm-dialog"
    >
      {named ? (
        <p className="sc-confirm-dialog__object">
          <span className="sc-visually-hidden">Applies to </span>‘{objectName}’
        </p>
      ) : null}
      {body ? <p className="sc-confirm-dialog__body">{body}</p> : null}
      {reason !== "none" ? (
        <TextArea
          id={reasonId}
          labelText={reason === "required" ? "Reason (required)" : "Reason (optional)"}
          helperText={reason === "required" ? "Saved with the change, so others can see why." : undefined}
          value={reasonText}
          invalid={touched && missingReason}
          invalidText="Add a short reason to continue."
          onChange={(event) => setReasonText(event.target.value)}
          onBlur={() => setTouched(true)}
          rows={3}
        />
      ) : null}
    </Modal>
  );
}
