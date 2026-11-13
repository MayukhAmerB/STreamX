import { forwardRef } from "react";
import { Link as RouterLink } from "react-router-dom";

import { ArrowRightIcon, LaunchIcon } from "./icons";
import { cx, isExternalHref } from "./utils";

/**
 * Text link on the tokens (--cds-link-primary, underline on hover, focus ring).
 * In-app paths use the router; http(s) links open a new tab and say so to
 * screen readers. `inline` underlines inside running text; `arrow` adds a
 * trailing arrow for standalone calls to action.
 */
const Link = forwardRef(function Link(
  { href, external, inline = false, arrow = false, size = "md", className, children, ...rest },
  ref
) {
  const opensElsewhere = external ?? isExternalHref(href);
  const newTab = opensElsewhere && /^https?:/i.test(String(href || ""));
  const classes = cx("sk-link", inline && "sk-link--inline", size === "lg" && "sk-link--lg", className);
  const content = (
    <>
      <span>{children}</span>
      {newTab ? <LaunchIcon className="sk-link__icon" /> : arrow ? <ArrowRightIcon className="sk-link__icon" /> : null}
      {newTab ? <span className="sk-visually-hidden"> (opens in a new tab)</span> : null}
    </>
  );
  if (opensElsewhere) {
    return (
      <a
        ref={ref}
        className={classes}
        href={href}
        target={newTab ? "_blank" : undefined}
        rel={newTab ? "noopener noreferrer" : undefined}
        {...rest}
      >
        {content}
      </a>
    );
  }
  return (
    <RouterLink ref={ref} className={classes} to={href} {...rest}>
      {content}
    </RouterLink>
  );
});

export default Link;
