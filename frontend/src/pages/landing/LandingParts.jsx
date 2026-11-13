// Small building blocks shared by the landing bands.
import { cx } from "../../site-kit";

/** Band heading block: optional eyebrow, the h2 and an optional lead (max 66ch). */
export function BandHeading({ id, eyebrow, title, subtitle, className, children }) {
  return (
    <div className={cx("lp-heading", className)}>
      {eyebrow ? <p className="lp-eyebrow">{eyebrow}</p> : null}
      <h2 id={id} className="lp-h2">
        {title}
      </h2>
      {subtitle ? <p className="lp-lead">{subtitle}</p> : null}
      {children}
    </div>
  );
}

/** Arrow (Carbon arrow--right, 16 px). */
export function ArrowRight({ className }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M11.8 7.5 8.1 3.8l.7-.7L13.7 8l-4.9 4.9-.7-.7 3.7-3.7H2v-1z" />
    </svg>
  );
}

/** 32 px line icons for "Why learners choose" (Carbon-like strokes). */
export function WhyIcon({ type }) {
  const common = {
    width: 32,
    height: 32,
    viewBox: "0 0 32 32",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": "true",
    focusable: "false",
  };
  if (type === "target") {
    return (
      <svg {...common}>
        <circle cx="16" cy="16" r="11" />
        <circle cx="16" cy="16" r="6" />
        <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (type === "stack") {
    return (
      <svg {...common}>
        <path d="M6 24h20M6 24V18h5v6M13.5 24V12h5v12M21 24V7h5v17" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M5 9h14M5 16h9M5 23h12" />
      <circle cx="24" cy="16" r="3" />
    </svg>
  );
}

/** "Friday, Saturday, Sunday" → "Fri, Sat, Sun". */
const DAY_ABBREVIATIONS = [
  ["Monday", "Mon"],
  ["Tuesday", "Tue"],
  ["Wednesday", "Wed"],
  ["Thursday", "Thu"],
  ["Friday", "Fri"],
  ["Saturday", "Sat"],
  ["Sunday", "Sun"],
];

export function formatScheduleDays(value) {
  const text = String(value || "").trim();
  if (!text) return "Fri, Sat, Sun";
  return DAY_ABBREVIATIONS.reduce((out, [full, short]) => out.replace(new RegExp(full, "gi"), short), text);
}
