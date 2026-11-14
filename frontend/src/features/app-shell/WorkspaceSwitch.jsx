// Workspace switch: Learn | Teach (instructors) or Learn | Admin (staff)
// (plan §3.1, M13). OWNER: WS-B. Built on the design kit's SegmentedSwitch.
//
// A disabled segment (Teach while the Teachers section is off) stays
// focusable; focusing or pressing it shows the reason in a polite line under
// the switch instead of doing nothing. When Teach becomes available for the
// first time a 6 px "New" dot marks it until the viewer opens it (M20).
import { useCallback, useEffect, useId, useState } from "react";
import { SegmentedSwitch } from "./ui";

export const TEACH_SEEN_KEY = "sc.teach.seen";

function readSeen() {
  try {
    return globalThis.localStorage?.getItem(TEACH_SEEN_KEY) === "1";
  } catch {
    return true; // Storage blocked: never nag.
  }
}

export function markTeachSeen() {
  try {
    globalThis.localStorage?.setItem(TEACH_SEEN_KEY, "1");
  } catch {
    // Storage blocked: the dot simply never shows.
  }
}

function TeachLabel({ isNew }) {
  return (
    <>
      Teach
      {isNew ? (
        <span className="cds-app-new-dot" aria-hidden="true" />
      ) : null}
      {isNew ? <span className="cds--visually-hidden"> (new)</span> : null}
    </>
  );
}

export default function WorkspaceSwitch({ options = [], value, onChange, className = "" }) {
  const reasonId = useId();
  const [showReason, setShowReason] = useState(false);
  const [teachSeen, setTeachSeen] = useState(() => (typeof window === "undefined" ? true : readSeen()));
  const teach = options.find((option) => option.key === "teach");
  const teachEnabled = teach?.state === "enabled";

  // Opening Teach clears the "New" dot for good.
  useEffect(() => {
    if (value === "teach" && teachEnabled && !teachSeen) {
      markTeachSeen();
      setTeachSeen(true);
    }
  }, [value, teachEnabled, teachSeen]);

  const visible = options.filter((option) => option.state !== "hidden");
  const disabled = visible.find((option) => option.state === "disabled" && option.reason);
  const reveal = useCallback(() => {
    if (disabled) setShowReason(true);
  }, [disabled]);

  if (visible.length < 2) return null;

  const switchOptions = visible.map((option) =>
    option.key === "teach" ? { ...option, label: <TeachLabel isNew={teachEnabled && !teachSeen} /> } : option
  );

  return (
    <div
      className={`cds-app-workspace ${className}`.trim()}
      onClickCapture={reveal}
      onFocusCapture={reveal}
      onBlurCapture={(event) => {
        if (!event.currentTarget?.contains?.(event.relatedTarget)) setShowReason(false);
      }}
    >
      <SegmentedSwitch label="Workspace" options={switchOptions} value={value} onChange={onChange} />
      <p id={reasonId} className="cds-app-workspace__reason" aria-live="polite">
        {showReason && disabled ? `${disabled.label}: ${disabled.reason}` : ""}
      </p>
    </div>
  );
}
