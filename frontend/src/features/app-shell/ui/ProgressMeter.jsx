import { CheckmarkFilled } from "@carbon/icons-react";

/**
 * Course progress: "30% complete" with the lesson count on one line and a
 * slim champagne bar (green + check icon once completed). The bar is a real
 * progressbar for assistive tech.
 */
export default function ProgressMeter({ progress, name = "Course", className = "" }) {
  const percent = Math.min(100, Math.max(0, Math.round(Number(progress?.percent) || 0)));
  const completed = progress?.status === "completed";
  const summary = progress?.summary || "";
  return (
    <div className={`cds-meter${completed ? " cds-meter--done" : ""}${className ? ` ${className}` : ""}`}>
      <div className="cds-meter__row">
        <span className="cds-meter__value">
          {completed ? <CheckmarkFilled size={16} aria-hidden="true" className="cds-meter__icon" /> : null}
          {percent}% complete
        </span>
        {summary ? <span className="cds-meter__summary">{summary}</span> : null}
      </div>
      <div
        className="cds-meter__track"
        role="progressbar"
        aria-label={`${name} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={summary ? `${percent}% complete, ${summary}` : `${percent}% complete`}
      >
        <span className="cds-meter__fill" style={{ inlineSize: `${percent}%` }} />
      </div>
    </div>
  );
}
