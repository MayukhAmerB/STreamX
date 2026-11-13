import { forwardRef, useId } from "react";
import { Link as RouterLink } from "react-router-dom";

import { cx, isExternalHref } from "./utils";

export const BUTTON_KINDS = ["primary", "secondary", "tertiary", "ghost"];
export const BUTTON_SIZES = ["lg", "md"];

function Spinner() {
  return <span className="sk-button__spinner" aria-hidden="true" />;
}

/**
 * Carbon-style button on the site tokens (no Carbon CSS).
 *
 * - kind: primary | secondary | tertiary | ghost; size: lg (48 px) | md (40 px).
 * - href renders a link (router Link for in-app paths, <a> for external ones).
 * - disabled never uses the native attribute: the control stays focusable with
 *   aria-disabled="true", has no href, ignores activation, and points
 *   aria-describedby at `disabledReason`, shown as a tooltip on hover/focus.
 * - loading: aria-busy="true", an inline spinner and no activation.
 */
const Button = forwardRef(function Button(
  {
    kind = "primary",
    size = "lg",
    href,
    external,
    disabled = false,
    disabledReason = "",
    loading = false,
    loadingText,
    icon,
    fullWidth = false,
    type = "button",
    className,
    children,
    onClick,
    ...rest
  },
  ref
) {
  const reasonId = useId();
  const inactive = disabled || loading;
  const classes = cx(
    "sk-button",
    `sk-button--${BUTTON_KINDS.includes(kind) ? kind : "primary"}`,
    `sk-button--${BUTTON_SIZES.includes(size) ? size : "lg"}`,
    fullWidth && "sk-button--full",
    disabled && "is-disabled",
    loading && "is-loading",
    className
  );
  const content = (
    <>
      {loading ? <Spinner /> : null}
      <span className="sk-button__label">{loading && loadingText ? loadingText : children}</span>
      {icon && !loading ? <span className="sk-button__icon">{icon}</span> : null}
    </>
  );

  if (href && !inactive) {
    const opensElsewhere = external ?? isExternalHref(href);
    if (opensElsewhere) {
      const newTab = external !== false && /^https?:/i.test(href);
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
          {content}
          {newTab ? <span className="sk-visually-hidden"> (opens in a new tab)</span> : null}
        </a>
      );
    }
    return (
      <RouterLink ref={ref} className={classes} to={href} onClick={onClick} {...rest}>
        {content}
      </RouterLink>
    );
  }

  const blockActivation = (event) => {
    event.preventDefault();
    event.stopPropagation?.();
  };
  const describedBy = cx(rest["aria-describedby"], disabled && disabledReason ? reasonId : "") || undefined;

  const button = (
    <button
      ref={ref}
      // A form button that is disabled or busy must not submit either.
      type={inactive ? "button" : type}
      className={classes}
      aria-disabled={disabled ? "true" : undefined}
      aria-busy={loading ? "true" : undefined}
      onClick={inactive ? blockActivation : onClick}
      {...rest}
      aria-describedby={describedBy}
    >
      {content}
    </button>
  );

  if (!(disabled && disabledReason)) return button;
  return (
    <span className={cx("sk-button-wrap", fullWidth && "sk-button-wrap--full")}>
      {button}
      <span id={reasonId} role="tooltip" className="sk-tooltip">
        {disabledReason}
      </span>
    </span>
  );
});

export default Button;
