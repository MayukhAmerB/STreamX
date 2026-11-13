import { cx } from "./utils";

const STATUSES = ["complete", "current", "incomplete"];

/**
 * Steps as an ordered list: horizontal from the md breakpoint, vertical on
 * phones (or always with `vertical`). The current step has
 * aria-current="step"; each step's status is also in visually hidden text.
 *
 * steps: [{ title, description?, status?: "complete" | "current" | "incomplete" }]
 * currentIndex: marks earlier steps complete and that step current (when
 * steps carry no status of their own).
 */
export default function ProgressIndicator({ steps = [], currentIndex, vertical = false, label, className, ...rest }) {
  const rows = Array.isArray(steps) ? steps.filter(Boolean) : [];
  if (rows.length === 0) return null;
  const statusOf = (step, index) => {
    if (STATUSES.includes(step.status)) return step.status;
    if (typeof currentIndex === "number") {
      if (index < currentIndex) return "complete";
      if (index === currentIndex) return "current";
    }
    return "incomplete";
  };
  return (
    <ol
      className={cx("sk-progress", vertical && "sk-progress--vertical", className)}
      aria-label={label}
      {...rest}
    >
      {rows.map((step, index) => {
        const status = statusOf(step, index);
        return (
          <li
            key={step.title || index}
            className={cx("sk-progress__step", `sk-progress__step--${status}`)}
            aria-current={status === "current" ? "step" : undefined}
          >
            <span className="sk-progress__marker" aria-hidden="true">
              {index + 1}
            </span>
            <span className="sk-progress__text">
              <span className="sk-progress__title">{step.title}</span>
              <span className="sk-visually-hidden">
                {status === "complete" ? " (complete)" : status === "current" ? " (current step)" : ""}
              </span>
              {step.description ? <span className="sk-progress__description">{step.description}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
