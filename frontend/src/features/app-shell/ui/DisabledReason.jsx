// DisabledReason (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// A control the viewer cannot use yet: aria-disabled, still focusable, never
// a link (no href, no onClick), a lock icon, and the reason both in
// aria-describedby and in a small toggletip that appears on hover, focus or
// tap (fast-02 fade). Disabled is grey (Carbon text-disabled), never red.
import { Locked } from "@carbon/icons-react";
import { useId, useState } from "react";
import "./overhaul.scss";

export default function DisabledReason({ as: Element = "span", reason, children, icon = "locked", className = "", href: _href, onClick: _onClick, to: _to, ...rest }) {
  const reasonId = useId();
  const [pinned, setPinned] = useState(false);
  return (
    <Element
      {...rest}
      className={`sc-disabled-reason ${className}`.trim()}
      aria-disabled="true"
      aria-describedby={reasonId}
      tabIndex={0}
      data-tip={pinned ? "open" : undefined}
      onClick={(event) => {
        event.preventDefault?.();
        setPinned((value) => !value);
      }}
      onBlur={() => setPinned(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setPinned(false);
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault?.();
          setPinned(true);
        }
      }}
    >
      {icon === "locked" ? <Locked size={16} aria-hidden="true" className="sc-disabled-reason__icon" /> : null}
      <span className="sc-disabled-reason__label">{children}</span>
      <span id={reasonId} role="tooltip" className="sc-disabled-reason__tip">
        {reason}
      </span>
    </Element>
  );
}
