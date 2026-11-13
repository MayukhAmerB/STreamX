import { forwardRef, useId } from "react";
import { Link as RouterLink } from "react-router-dom";

import { ArrowRightIcon, LaunchIcon } from "./icons";
import Tag from "./Tag";
import { cx, isActivationKey, isExternalHref } from "./utils";

/** A static surface on the layer tokens. `featured` adds the accent top rule (dark bands). */
export function Tile({ as: Element = "div", featured = false, className, children, ...rest }) {
  return (
    <Element className={cx("sk-tile", featured && "sk-tile--featured", className)} {...rest}>
      {children}
    </Element>
  );
}

export const COMING_SOON_REASON = "Coming soon · No courses yet";

/**
 * A whole-tile link with a built-in disabled state (plan §7.2 rule 2).
 *
 * Enabled: one link (router Link or external <a>) with a trailing arrow.
 * Disabled (or `comingSoon`): no href, role="link" + aria-disabled="true",
 * still focusable (tabIndex 0) so keyboard and screen-reader users reach the
 * visible reason, which aria-describedby points at; activation does nothing
 * and there is no arrow. `comingSoon` also shows the "Coming soon" tag.
 */
export const ClickableTile = forwardRef(function ClickableTile(
  {
    href,
    external,
    disabled = false,
    comingSoon = false,
    disabledReason,
    featured = false,
    hideArrow = false,
    className,
    children,
    onClick,
    ...rest
  },
  ref
) {
  const reasonId = useId();
  const isDisabled = disabled || comingSoon || !href;
  const classes = cx("sk-tile", "sk-tile--clickable", featured && "sk-tile--featured", isDisabled && "is-disabled", className);

  if (isDisabled) {
    const reason = disabledReason || (comingSoon ? COMING_SOON_REASON : "Not available yet");
    const ignore = (event) => {
      if (event.type === "keydown" && !isActivationKey(event)) return;
      event.preventDefault();
    };
    return (
      <div
        ref={ref}
        role="link"
        aria-disabled="true"
        tabIndex={0}
        className={classes}
        onClick={ignore}
        onKeyDown={ignore}
        {...rest}
        aria-describedby={cx(rest["aria-describedby"], reasonId)}
      >
        {comingSoon ? (
          <span className="sk-tile__status">
            <Tag type="coming-soon" />
          </span>
        ) : null}
        <div className="sk-tile__body">{children}</div>
        <p id={reasonId} className="sk-tile__reason">
          {reason}
        </p>
      </div>
    );
  }

  const opensElsewhere = external ?? isExternalHref(href);
  const arrow = hideArrow ? null : (
    <span className="sk-tile__arrow">{opensElsewhere ? <LaunchIcon /> : <ArrowRightIcon />}</span>
  );
  const body = (
    <>
      <div className="sk-tile__body">{children}</div>
      {arrow}
    </>
  );
  if (opensElsewhere) {
    const newTab = /^https?:/i.test(href);
    return (
      <a
        ref={ref}
        className={classes}
        href={href}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noopener noreferrer" : undefined}
        onClick={onClick}
        {...rest}
      >
        {body}
        {newTab ? <span className="sk-visually-hidden"> (opens in a new tab)</span> : null}
      </a>
    );
  }
  return (
    <RouterLink ref={ref} className={classes} to={href} onClick={onClick} {...rest}>
      {body}
    </RouterLink>
  );
});
