import { cx, useDelayedFlag } from "./utils";

export const SKELETON_DELAY_MS = 300;

/**
 * Layout-matching loading placeholder (plan §7.2 rule 6). Renders nothing for
 * the first `delay` ms (default 300), so fast responses never flash; then a
 * status region (aria-busy, labelled "Loading …") with `lines` text bars or
 * one block of `width` x `height`. The bars shimmer only without reduced motion.
 *
 * `decorative`: the skeleton is one piece of a larger placeholder whose
 * container is the single status region (see LoadingRegion), so it is
 * aria-hidden and not announced again.
 */
export default function Skeleton({
  delay = SKELETON_DELAY_MS,
  variant = "text",
  lines = 3,
  width,
  height,
  label = "Loading",
  decorative = false,
  className,
  style,
  ...rest
}) {
  const visible = useDelayedFlag(true, delay);
  if (!visible) return null;
  const count = variant === "text" ? Math.max(1, Number(lines) || 1) : 1;
  return (
    <div
      role={decorative ? undefined : "status"}
      aria-busy={decorative ? undefined : "true"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? "true" : undefined}
      className={cx("sk-skeleton", `sk-skeleton--${variant}`, className)}
      style={{ ...style, width }}
      {...rest}
    >
      {Array.from({ length: count }, (_unused, index) => (
        <span
          key={index}
          className="sk-skeleton__bar"
          aria-hidden="true"
          style={variant === "text" ? { width: index === count - 1 && count > 1 ? "60%" : "100%" } : { height }}
        />
      ))}
    </div>
  );
}

/**
 * One status region for a group of decorative skeletons (plan §7.2 rule 6):
 * screen readers hear "Loading …" once, not once per placeholder.
 */
export function LoadingRegion({ label = "Loading", as: Element = "div", className, children, ...rest }) {
  return (
    <Element role="status" aria-busy="true" className={className} {...rest}>
      <span className="sk-visually-hidden">{label}</span>
      {children}
    </Element>
  );
}
