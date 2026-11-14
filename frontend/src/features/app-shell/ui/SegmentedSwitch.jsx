// SegmentedSwitch (UI overhaul plan §2.5, §3.1, M13, Appendix A.5). OWNER: WS-A.
// The workspace switch (Learn | Teach, Learn | Admin). A thumb slides under
// the selected segment with a transform (moderate-02, standard-expressive).
// A disabled segment stays focusable, shows a lock and explains itself (a
// toggletip on hover, focus or tap, plus aria-describedby); hidden options
// are not rendered at all.
import { Locked } from "@carbon/icons-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./overhaul.scss";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function SegmentedSwitch({ options = [], value, onChange, label = "Workspace" }) {
  const baseId = useId();
  const visible = options.filter((option) => option.state !== "hidden");
  const group = useRef(null);
  const [thumb, setThumb] = useState(null);
  const [tip, setTip] = useState(null);

  useIsoLayoutEffect(() => {
    const node = group.current;
    const selected = node?.querySelector?.("[aria-pressed='true']");
    setThumb(selected ? { x: selected.offsetLeft || 0, width: selected.offsetWidth || 0 } : null);
  }, [value, visible.length]);

  return (
    <div className="sc-segmented" role="group" aria-label={label} ref={group}>
      {thumb && thumb.width ? (
        <span className="sc-segmented__thumb" aria-hidden="true" style={{ transform: `translateX(${thumb.x}px) scaleX(${thumb.width})` }} />
      ) : null}
      {visible.map((option) => {
        const disabled = option.state === "disabled";
        const reasonId = `${baseId}-${option.key}-reason`;
        return (
          <button
            key={option.key}
            type="button"
            className="sc-segmented__option"
            aria-pressed={option.key === value}
            aria-disabled={disabled ? "true" : undefined}
            aria-describedby={disabled && option.reason ? reasonId : undefined}
            data-tip={tip === option.key ? "open" : undefined}
            onBlur={() => setTip(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTip(null);
            }}
            onClick={() => {
              if (disabled) {
                setTip((current) => (current === option.key ? null : option.key));
                return;
              }
              if (option.key !== value) onChange?.(option.key);
            }}
          >
            {disabled ? <Locked size={16} aria-hidden="true" /> : null}
            {option.label}
            {disabled && option.reason ? (
              <span id={reasonId} role="tooltip" className="sc-segmented__tip">
                {option.reason}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
