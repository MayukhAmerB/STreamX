// Badge and StatusBadge (BUILD_PLAN §1.2 "Status without hue"). OWNER: WS-KIT.
//
// Status is never colour alone: every StatusBadge renders a monochrome icon
// AND its word, and kinds differ by luminance and line style (solid, dashed,
// inverse), never by hue. Golden white marks only `attention`, `live` and `free`.
import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import { forwardRef } from "react";

import { Alert, CheckCircle, Clock, ClockDashed, HalfCircle, Lock, OctagonX } from "./icons";
import { cn } from "./lib/cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium uppercase",
  {
    variants: {
      variant: {
        outline: "border-white/15 text-white/[.82]",
        solid: "border-white bg-white text-black",
        accent: "border-accent/40 bg-accent/[.08] text-accent",
        muted: "border-dashed border-white/25 text-muted-foreground",
        chip: "border-white/10 bg-white/[.04] normal-case tracking-normal text-muted-foreground",
      },
      size: {
        sm: "px-2.5 py-1 text-eyebrow",
        md: "px-3 py-1.5 text-[11px] tracking-badge",
        micro: "rounded px-1.5 py-0 text-[10px] tracking-eyebrow",
      },
    },
    defaultVariants: { variant: "outline", size: "sm" },
  }
);

export const Badge = forwardRef(function Badge({ className, variant, size, asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot : "span";
  return <Comp ref={ref} className={cn(badgeVariants({ variant, size }), className)} {...props} />;
});

/** The status vocabulary: icon + default word + treatment. */
export const STATUS_KINDS = {
  done: { icon: CheckCircle, label: "Done", className: "border-white/30 text-white", knockout: "#000" },
  available: { icon: CheckCircle, label: "Available", className: "border-white/30 text-white", knockout: "#000" },
  open: { icon: CheckCircle, label: "Open", className: "border-white/30 text-white", knockout: "#000" },
  progress: { icon: HalfCircle, label: "In progress", className: "border-white/[.18] text-white/80" },
  building: { icon: HalfCircle, label: "Building", className: "border-white/[.18] text-white/80" },
  attention: { icon: Alert, label: "Needs attention", className: "border-accent/40 text-accent" },
  critical: { icon: OctagonX, label: "Error", className: "border-white bg-white text-black", knockout: "#fff" },
  soon: { icon: Clock, label: "Coming soon", className: "border-dashed border-white/25 text-muted-foreground" },
  planned: { icon: ClockDashed, label: "Planned", className: "border-dashed border-white/25 text-muted-foreground" },
  locked: { icon: Lock, label: "Locked", className: "border-dashed border-white/25 text-muted-foreground" },
  disabled: { icon: Clock, label: "Off", className: "border-dashed border-white/25 text-muted-foreground" },
  live: { icon: null, label: "Live", className: "border-accent/40 text-accent" },
  free: { icon: null, label: "Free", className: "border-accent/50 text-accent" },
  neutral: { icon: null, label: "", className: "border-white/15 text-muted-foreground" },
};

/** A golden dot that pulses three times (static under reduced motion): the one LIVE glow. */
export function LiveDot({ className }) {
  return (
    <span aria-hidden="true" className={cn("relative inline-flex size-2", className)}>
      <span className="absolute inset-0 rounded-full bg-accent shadow-[0_0_8px_rgb(243_226_179/.7)] motion-safe:animate-live-pulse" />
    </span>
  );
}

/**
 * <StatusBadge kind="soon" /> → [clock] COMING SOON
 * `label` overrides the word (it is always rendered); `size` = sm | md.
 */
export const StatusBadge = forwardRef(function StatusBadge({ kind = "neutral", label, size = "sm", className, ...rest }, ref) {
  const spec = STATUS_KINDS[kind] || STATUS_KINDS.neutral;
  const Icon = spec.icon;
  const word = label ?? spec.label;
  return (
    <span
      ref={ref}
      data-status={kind}
      // The knockout (the tick cut out of a filled icon) is a class, not an
      // inline style, so an inverted card can flip it (Card.jsx cardStatus).
      className={cn(
        badgeVariants({ size }),
        "bg-black/0",
        spec.knockout === "#fff" ? "[--icon-knockout:#fff]" : spec.knockout ? "[--icon-knockout:#000]" : "",
        spec.className,
        className
      )}
      {...rest}
    >
      {kind === "live" ? <LiveDot /> : Icon ? <Icon size={12} /> : null}
      <span>{word}</span>
    </span>
  );
});

export default Badge;
