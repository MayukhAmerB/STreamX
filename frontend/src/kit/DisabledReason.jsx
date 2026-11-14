// DisabledReason (BUILD_PLAN §1.4, PHILOSOPHY T4/T5; owner rule "disable, not hide").
// OWNER: WS-KIT.
//
// An action the viewer cannot take yet (Pentesting "Coming soon", a plan
// without a confirmed price): it keeps the button's place and label, is
// `aria-disabled` but still focusable (so keyboard and screen-reader users
// meet the reason), never navigates or submits, and shows the reason as
// visible text under it, linked with `aria-describedby`. Calm, never red.
import { forwardRef, useId } from "react";

import { buttonVariants } from "./Button";
import { Clock, Lock } from "./icons";
import { cn } from "./lib/cn";

const ICONS = { lock: Lock, clock: Clock, none: null };

/**
 * <DisabledReason reason="Pentesting is coming soon…" size="lg" icon="clock">Enrol</DisabledReason>
 * - `reasonVisibility`: "visible" (default) or "sr-only" (the reason is then
 *   still announced, e.g. when the same reason is already printed nearby).
 * - `look`: "muted" (dashed, default) or a Button variant to keep the original look.
 */
export const DisabledReason = forwardRef(function DisabledReason(
  {
    reason,
    children,
    size = "lg",
    shape = "rect",
    block = false,
    look = "muted",
    icon = "clock",
    reasonVisibility = "visible",
    className,
    reasonClassName,
    align = "start",
    id,
    // Swallowed on purpose: a disabled action never navigates or fires.
    href: _href,
    to: _to,
    onClick: _onClick,
    asChild: _asChild,
    ...rest
  },
  ref
) {
  const autoId = useId();
  const reasonId = `${id || autoId}-reason`;
  const Icon = ICONS[icon] === undefined ? Clock : ICONS[icon];
  return (
    <span
      className={cn("inline-flex flex-col gap-2", block && "flex w-full", align === "center" ? "items-center text-center" : "items-start", className)}
      data-disabled-reason=""
    >
      <button
        ref={ref}
        id={id}
        type="button"
        aria-disabled="true"
        aria-describedby={reasonId}
        onClick={(event) => event.preventDefault()}
        className={cn(buttonVariants({ variant: look, size, shape, block }), "cursor-not-allowed")}
        {...rest}
      >
        {Icon ? <Icon size={16} /> : null}
        {children}
      </button>
      <span
        id={reasonId}
        className={cn(reasonVisibility === "sr-only" ? "sr-only" : "max-w-sm text-sm leading-6 text-subtle", reasonClassName)}
      >
        {reason}
      </span>
    </span>
  );
});

export default DisabledReason;
