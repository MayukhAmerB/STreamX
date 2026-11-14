// BulkBar (UI overhaul plan §2.5, §4.6, Appendix A.5). OWNER: WS-A.
// "3 selected · Approve · Reject · Export": slides up (110 ms, transform +
// opacity) when the first row is selected and sticks to the bottom of the
// list. Danger actions are red ghost buttons; the caller confirms them.
import { Button } from "@carbon/react";
import "./overhaul.scss";

export default function BulkBar({ count = 0, actions = [], onClear, noun = "selected" }) {
  if (!count) return null;
  return (
    <div className="sc-bulk-bar" role="region" aria-label="Bulk actions">
      <p className="sc-bulk-bar__count" aria-live="polite">
        <strong>{count}</strong> {noun}
      </p>
      <div className="sc-bulk-bar__actions">
        {actions.map((action) => (
          <Button
            key={action.label}
            size="sm"
            kind={action.danger ? "danger--ghost" : action.primary ? "primary" : "ghost"}
            onClick={action.onClick}
            disabled={action.disabled}
            renderIcon={action.icon}
          >
            {action.label}
          </Button>
        ))}
        <Button size="sm" kind="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
