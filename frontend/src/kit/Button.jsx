// Button (PHILOSOPHY §2.7 "Buttons", §5 Buttons; BUILD_PLAN §1.4). OWNER: WS-KIT.
//
// Plain rectangles with an 8px corner: primary = solid white with black text,
// secondary = transparent with a white/18 hairline, accent = golden white
// (the ONE glowing CTA per viewport), ghost and link. Hover darkens the fill
// to 88% in 150 ms (M1); a trailing chevron/arrow nudges 4px (M2). Sizes:
// sm h-10 px-5 (nav), md h-11 px-6, lg h-12 px-6 (hero, catalogue).
// `shape="pill"` is for plan CTAs only; `tactile` adds the pressed shadow (M8).
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { forwardRef } from "react";

import { ArrowRight, ArrowUpRight, ChevronRight } from "./icons";
import { cn } from "./lib/cn";

export const buttonVariants = cva(
  [
    "group/button relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-colors duration-150 ease-standard motion-reduce:transition-none",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-disabled:cursor-not-allowed",
  ],
  {
    variants: {
      variant: {
        primary: "bg-white text-black hover:bg-white/[.88] active:bg-white/80 aria-disabled:hover:bg-white",
        secondary: "border border-white/20 bg-transparent text-white hover:bg-white/[.08] active:bg-white/[.12]",
        invert: "border border-white/20 bg-transparent text-white hover:border-white hover:bg-white hover:text-black",
        accent: "bg-accent text-accent-foreground hover:bg-accent-strong active:bg-accent-deep",
        ghost: "bg-transparent text-white/[.82] hover:bg-white/[.06] hover:text-white",
        link: "h-auto bg-transparent px-0 text-white underline-offset-4 hover:underline",
        // Disabled-with-reason look (used by DisabledReason): calm, dashed, never red.
        muted: "border border-dashed border-white/25 bg-white/[.06] text-muted-foreground",
      },
      size: {
        sm: "h-10 px-5 text-sm",
        md: "h-11 px-6 text-sm",
        lg: "h-12 px-6 text-sm",
        xs: "h-8 px-3 text-xs",
        icon: "size-10 p-0",
      },
      shape: {
        rect: "rounded-md",
        pill: "rounded-full",
      },
      block: {
        true: "w-full",
        false: "",
      },
      tactile: {
        true: "shadow-tactile active:translate-y-[3px] active:shadow-tactile-pressed motion-reduce:active:translate-y-0",
        false: "",
      },
    },
    compoundVariants: [
      { variant: "link", size: ["sm", "md", "lg", "xs"], className: "h-auto px-0" },
      { shape: "pill", size: "lg", className: "min-h-12 px-5" },
    ],
    defaultVariants: { variant: "primary", size: "sm", shape: "rect", block: false, tactile: false },
  }
);

const TRAILING = { chevron: ChevronRight, arrow: ArrowRight, external: ArrowUpRight };

/** The trailing glyph that nudges on hover (M2: translate-x-1 in 200 ms; the external arrow goes up-right). */
export function TrailingIcon({ kind = "chevron", className }) {
  const Icon = TRAILING[kind] || ChevronRight;
  return (
    <Icon
      size={16}
      className={cn(
        "transition-transform duration-200 ease-standard motion-reduce:transition-none",
        kind === "external"
          ? "group-hover/button:-translate-y-0.5 group-hover/button:translate-x-0.5"
          : "group-hover/button:translate-x-1",
        "group-aria-disabled/button:translate-x-0 group-aria-disabled/button:translate-y-0",
        className
      )}
    />
  );
}

/**
 * <Button variant size shape block tactile trailing asChild>
 * - `trailing`: "chevron" | "arrow" | "external" adds the nudging glyph.
 * - `asChild`: render the child element (e.g. a router <Link>) with the button classes.
 * - `type` defaults to "button" so a button never submits a form by accident.
 */
export const Button = forwardRef(function Button(
  { className, variant, size, shape, block, tactile, trailing, leading, asChild = false, type, children, ...props },
  ref
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : type || "button"}
      className={cn(buttonVariants({ variant, size, shape, block, tactile }), className)}
      {...props}
    >
      {leading || null}
      <Slottable>{children}</Slottable>
      {trailing ? <TrailingIcon kind={trailing} /> : null}
    </Comp>
  );
});

export default Button;
