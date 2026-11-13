import { cx } from "./utils";

export const BAND_THEMES = ["white", "g10", "g100"];

/**
 * A full-bleed page band (plan §7.3): <section data-theme="…"> sets every
 * --cds-* token for its subtree; padding is 64 px on phones and 96 px from lg;
 * the content sits in the Carbon 2x grid (4 / 8 / 16 columns, 32 px gutter,
 * max 1584 px). Children are grid items: wrap them in <Column>.
 *
 * Pass `labelledBy` (the id of the band's heading) so the region is named.
 */
export default function Band({
  theme = "white",
  as: Element = "section",
  labelledBy,
  grid = true,
  className,
  innerClassName,
  children,
  ...rest
}) {
  return (
    <Element
      data-theme={BAND_THEMES.includes(theme) ? theme : "white"}
      aria-labelledby={labelledBy}
      className={cx("sk-band", className)}
      {...rest}
    >
      <div className={cx("sk-band__inner", grid && "sk-grid", innerClassName)}>{children}</div>
    </Element>
  );
}

/** A standalone 2x grid (inside a Band it is already applied). */
export function Grid({ as: Element = "div", className, children, ...rest }) {
  return (
    <Element className={cx("sk-grid", className)} {...rest}>
      {children}
    </Element>
  );
}

const span = (value, max) => Math.min(max, Math.max(1, Number(value) || max));

/**
 * A grid item. sm (1-4), md (1-8) and lg (1-16) set the column span per
 * breakpoint (default: full width); `start` sets the lg start column.
 */
export function Column({ as: Element = "div", sm = 4, md, lg, start, className, style, children, ...rest }) {
  const vars = {
    "--sk-span-sm": span(sm, 4),
    "--sk-span-md": span(md ?? sm * 2, 8),
    "--sk-span-lg": span(lg ?? (md ?? sm * 2) * 2, 16),
    ...(start ? { "--sk-start-lg": span(start, 16) } : null),
  };
  return (
    <Element className={cx("sk-col", start && "sk-col--start", className)} style={{ ...vars, ...style }} {...rest}>
      {children}
    </Element>
  );
}
