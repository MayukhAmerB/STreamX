import { cx } from "./utils";

/**
 * Status vocabulary (plan §7.1): one meaning per word.
 * - live: on air right now (red), never anything else
 * - open: registration open (green)
 * - coming-soon: not purchasable yet (blue)
 * - previous-batch: closed to new buyers (gray)
 * - countdown: time remaining (neutral, never red)
 * - neutral: a plain label (category, format)
 */
export const TAG_VOCABULARY = {
  live: { label: "Live", color: "red" },
  open: { label: "Open", color: "green" },
  "coming-soon": { label: "Coming soon", color: "blue" },
  "previous-batch": { label: "Previous batch", color: "gray" },
  countdown: { label: "Countdown", color: "cool-gray" },
  neutral: { label: "", color: "gray" },
};

export default function Tag({ type = "neutral", size = "md", pill = true, className, children, ...rest }) {
  const entry = TAG_VOCABULARY[type] || TAG_VOCABULARY.neutral;
  const label = children ?? entry.label;
  return (
    <span
      className={cx(
        "sk-tag",
        `sk-tag--${entry.color}`,
        `sk-tag--${size === "sm" ? "sm" : "md"}`,
        pill && "sk-tag--pill",
        className
      )}
      data-status={type}
      {...rest}
    >
      {type === "live" ? <span className="sk-tag__live-dot" aria-hidden="true" /> : null}
      <span className="sk-tag__label">{label}</span>
    </span>
  );
}
