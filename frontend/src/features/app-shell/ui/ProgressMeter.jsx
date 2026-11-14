import { CheckmarkFilled } from "@carbon/icons-react";
import { Meter } from "../../../site-kit/motion";

/**
 * Course progress: "30% complete" with the lesson count on one line and the
 * shared Meter (M6: transform scaleX, fills once on first view, green with a
 * check once completed). The bar is a real progressbar for assistive tech.
 */
export default function ProgressMeter({ progress, name = "Course", className = "", accent = false }) {
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
      <Meter value={completed ? 1 : percent / 100} label={summary ? `${name} progress, ${summary}` : `${name} progress`} accent={accent} />
    </div>
  );
}
