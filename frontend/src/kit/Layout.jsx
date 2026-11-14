// Layout and structure pieces (PHILOSOPHY §2.6, §2.7). OWNER: WS-KIT.
// Frame (max-w-7xl, 20px / 32px gutters), Section (64 → 96 → 128px rhythm),
// StatStrip (one border-y band), Notice, Separator, Skeleton, Progress,
// Avatar / AvatarStack, Table.
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { createElement, forwardRef } from "react";

import { Info } from "./icons";
import { cn } from "./lib/cn";
import { Eyebrow } from "./Typography";

/** The content frame: max-w-7xl, px-5 (20px) at 390, px-8 above 640. */
export const Frame = forwardRef(function Frame({ as = "div", className, width = "frame", ...props }, ref) {
  const max = { frame: "max-w-7xl", plans: "max-w-6xl", headline: "max-w-5xl", narrow: "max-w-3xl", prose: "max-w-2xl" }[width] || "max-w-7xl";
  return createElement(as, { ref, className: cn("mx-auto w-full px-5 sm:px-8", max, className), ...props });
});

const SECTION_RHYTHM = {
  band: "py-16 sm:py-24 md:py-32", // display-headline bands
  normal: "py-16 sm:py-24",
  tight: "py-12 sm:py-16",
  none: "",
};

/** A full-bleed band on the black canvas with the 64/96/128 rhythm. */
export const Section = forwardRef(function Section({ as = "section", rhythm = "normal", className, ...props }, ref) {
  return createElement(as, { ref, className: cn("relative bg-background", SECTION_RHYTHM[rhythm] ?? SECTION_RHYTHM.normal, className), ...props });
});

/**
 * <StatStrip items={[{ value: "4", label: "free labs" }, …]} />
 * Cells centred, values white, labels in the text floor; 2 columns at 390.
 */
export function StatStrip({ items = [], className, columns }) {
  const cols = columns || Math.min(items.length, 4);
  const grid = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-2 sm:grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" }[cols] || "grid-cols-2 sm:grid-cols-4";
  return (
    <dl className={cn("stat-strip mx-auto w-full max-w-xl gap-y-3", grid, className)}>
      {items.map((item) => (
        <div key={`${item.value}-${item.label}`} className="flex flex-col items-center gap-0.5 px-2">
          <dt className="order-2">{item.label}</dt>
          <dd className="order-1 font-medium tabular-nums text-white">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Inline notice: icon + eyebrow + 16px title + muted body, on surface-1. */
export function Notice({ eyebrow, title, children, icon: Icon = Info, className, role, ...rest }) {
  return (
    <div role={role} className={cn("flex gap-4 rounded-lg border border-white/10 bg-surface-1 px-5 py-5 sm:px-6", className)} {...rest}>
      {Icon ? <Icon size={20} className="mt-0.5 shrink-0 text-subtle" /> : null}
      <div className="min-w-0">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        {title ? <p className={cn("text-base font-semibold text-white", eyebrow && "mt-1")}>{title}</p> : null}
        {children ? <div className={cn("text-sm leading-6 text-muted-foreground", (title || eyebrow) && "mt-1")}>{children}</div> : null}
      </div>
    </div>
  );
}

export const Separator = forwardRef(function Separator({ className, orientation = "horizontal", decorative = true, ...props }, ref) {
  return (
    <SeparatorPrimitive.Root
      ref={ref}
      decorative={decorative}
      orientation={orientation}
      className={cn("shrink-0 bg-white/10", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...props}
    />
  );
});

/** Static skeleton block (no shimmer loop: calm, and nothing to reduce). */
export function Skeleton({ className, ...props }) {
  return <div aria-hidden="true" className={cn("rounded-md bg-white/[.06]", className)} {...props} />;
}

/**
 * <Progress value={40} label="Course progress" /> golden-white fill on a white/10 track.
 * Width animates with transform (scaleX), never width.
 */
export const Progress = forwardRef(function Progress({ className, value = 0, max = 100, label, tone = "accent", ...props }, ref) {
  const pct = Math.max(0, Math.min(100, (Number(value) / Number(max || 100)) * 100));
  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      max={max}
      aria-label={label}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full w-full origin-left rounded-full transition-transform duration-500 ease-settle motion-reduce:transition-none",
          tone === "white" ? "bg-white" : "bg-accent"
        )}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </ProgressPrimitive.Root>
  );
});

export const Avatar = forwardRef(function Avatar({ className, src, alt = "", fallback, size = "md", ring = false, ...props }, ref) {
  const sizes = { sm: "size-7 text-[11px]", md: "size-9 text-xs", lg: "size-12 text-sm" };
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn("relative inline-flex shrink-0 overflow-hidden rounded-full bg-muted", sizes[size] || sizes.md, ring && "ring-2 ring-black", className)}
      {...props}
    >
      {src ? <AvatarPrimitive.Image src={src} alt={alt} className="aspect-square size-full object-cover grayscale" /> : null}
      <AvatarPrimitive.Fallback className="flex size-full items-center justify-center font-medium uppercase text-white/[.82]" delayMs={src ? 300 : 0}>
        {fallback}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});

/** Social-proof stack: overlapping avatars + a 12px line. */
export function AvatarStack({ people = [], label, className }) {
  return (
    <div className={cn("flex items-center justify-center gap-3", className)}>
      <div className="flex -space-x-2">
        {people.slice(0, 5).map((person) => (
          <Avatar key={person.name} size="sm" ring src={person.src} alt="" fallback={person.initials || person.name?.[0]} />
        ))}
      </div>
      {label ? <p className="text-xs text-muted-foreground">{label}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Table */

/** Scrolls sideways inside its own box (never the page) on narrow screens. */
export const Table = forwardRef(function Table({ className, wrapperClassName, minWidth, ...props }, ref) {
  return (
    <div className={cn("relative w-full overflow-x-auto rounded-lg border border-white/10", wrapperClassName)}>
      <table ref={ref} className={cn("w-full caption-bottom border-collapse text-sm", className)} style={minWidth ? { minWidth } : undefined} {...props} />
    </div>
  );
});

export const TableHeader = forwardRef(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn("border-b border-white/10", className)} {...props} />;
});

export const TableBody = forwardRef(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
});

export const TableRow = forwardRef(function TableRow({ className, highlighted = false, ...props }, ref) {
  return (
    <tr
      ref={ref}
      className={cn(
        "border-b border-white/[.08] transition-colors duration-150 hover:bg-white/[.025]",
        highlighted && "bg-accent/[.08] hover:bg-accent/[.1]",
        className
      )}
      {...props}
    />
  );
});

export const TableHead = forwardRef(function TableHead({ className, ...props }, ref) {
  return <th ref={ref} scope="col" className={cn("px-5 py-4 text-left align-middle text-xs font-medium uppercase tracking-chapter text-subtle", className)} {...props} />;
});

export const TableCell = forwardRef(function TableCell({ className, ...props }, ref) {
  return <td ref={ref} className={cn("px-5 py-4 align-middle text-sm text-[#d4d4d4]", className)} {...props} />;
});

export const TableCaption = forwardRef(function TableCaption({ className, ...props }, ref) {
  return <caption ref={ref} className={cn("mt-4 text-xs text-subtle", className)} {...props} />;
});
