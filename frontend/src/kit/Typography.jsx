// Type roles (PHILOSOPHY §2.2, §3.3; BUILD_PLAN §1.3). OWNER: WS-KIT.
//
// Geist does the talking; Handlee (handwritten) is the ONE human touch per
// headline: either one accent word at 1em (<Hand>) or a tilted handwritten
// full stop after each line (<HandPeriod>, via `periods`), never both. A dev
// warning fires when a heading breaks that rule. Small labels are Geist sans
// 10px at 0.14em (eyebrow), kickers 12px at 0.22em with the first word in
// golden white, and nothing on black goes below #8a8a8a (AA).
import { Children, createElement, forwardRef, isValidElement } from "react";

import { cn } from "./lib/cn";

const isDev = () => Boolean(import.meta.env?.DEV) || import.meta.env?.MODE === "test";

/** One handwritten accent word (Handlee 400 at 1em). `tone="gold"` only on the landing hero. */
export function Hand({ children, tone = "inherit", className, ...rest }) {
  return (
    <span
      data-hand=""
      className={cn("font-hand font-normal", tone === "gold" ? "text-accent" : tone === "soft" ? "text-white/[.82]" : "", className)}
      {...rest}
    >
      {children}
    </span>
  );
}
Hand.kitHand = true;

/** The handwritten full stop: Handlee, .52em, rotated -12deg, nudged down .16em, 82% opacity. */
export function HandPeriod({ className }) {
  return (
    <span aria-hidden="true" data-hand-period="" className={cn("hand-period", className)}>
      .
    </span>
  );
}
HandPeriod.kitHand = true;

function countHand(node) {
  let count = 0;
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;
    if (child.type?.kitHand) count += 1;
    else if (child.props?.children) count += countHand(child.props.children);
  });
  return count;
}

/** Warns in development when a heading carries more than one handwritten fragment kind. */
export function warnHandRule(name, { accentCount = 0, periods = false }) {
  if (!isDev()) return;
  if (accentCount > 1 || (accentCount > 0 && periods)) {
    console.warn(`[kit] ${name}: use exactly one Handlee fragment per heading (one accent word OR the hand periods, never both).`);
  }
}

const DISPLAY_SIZES = {
  // Page hero h1: 48 -> 128px (PHILOSOPHY §2.2 page-hero, lg:text-9xl)
  hero: "text-5xl sm:text-7xl md:text-8xl lg:text-9xl leading-none",
  // Section band h2: 48 -> 96px
  section: "text-5xl sm:text-7xl md:text-8xl leading-none",
  // Landing h1 under the calligraphy: 44 -> 72px
  landing: "text-[2.75rem] sm:text-5xl md:text-6xl xl:text-7xl leading-[1.02]",
  // Course detail h1: 48 -> 72px, tight
  detail: "text-5xl sm:text-6xl lg:text-7xl leading-[0.96] tracking-title-tight",
  // Section h2: 30 -> 60px
  sub: "text-3xl sm:text-5xl md:text-6xl leading-tight",
};

/**
 * <DisplayHeading as="h1" size="hero" lines={["Learn first", "Investigate after"]} periods />
 * or children with one <Hand> word. Each line is a `block` span; at 390 a long
 * line may wrap (we never force nowrap on phones, PHILOSOPHY T1 → 390).
 */
export const DisplayHeading = forwardRef(function DisplayHeading(
  { as = "h2", size = "section", lines, periods = false, align = "center", className, children, ...rest },
  ref
) {
  const accentCount = countHand(lines || children);
  warnHandRule("DisplayHeading", { accentCount, periods });
  const body = lines
    ? lines.map((line, index) => (
        <span key={index} className="block sm:whitespace-nowrap">
          {line}
          {periods ? <HandPeriod /> : null}
        </span>
      ))
    : children;
  return createElement(
    as,
    {
      ref,
      className: cn(
        "font-sans font-semibold text-white text-balance",
        DISPLAY_SIZES[size] || DISPLAY_SIZES.section,
        align === "center" ? "mx-auto text-center" : "text-left",
        className
      ),
      ...rest,
    },
    body
  );
});

/** 10px uppercase label at 0.14em in the text floor (#8a8a8a). `tone="accent"` for the page-level eyebrow. */
export function Eyebrow({ as = "p", tone = "subtle", className, children, ...rest }) {
  return createElement(
    as,
    {
      className: cn(
        "text-eyebrow font-medium uppercase",
        tone === "accent" ? "text-accent" : tone === "white" ? "text-white" : "text-subtle",
        className
      ),
      ...rest,
    },
    children
  );
}

/**
 * Kicker: 12px uppercase at 0.22em; the first part in golden white, the rest in
 * the text floor, joined by a short hairline dash ("COURSE — MEMBERS ONLY").
 */
export function Kicker({ lead, children, as = "p", className, ...rest }) {
  return createElement(
    as,
    { className: cn("flex flex-wrap items-center justify-center gap-3 text-kicker uppercase text-subtle", className), ...rest },
    lead ? <span className="text-accent">{lead}</span> : null,
    lead && children ? <span aria-hidden="true" className="h-px w-8 bg-white/20" /> : null,
    children ? <span>{children}</span> : null
  );
}

/** Chapter label running into a hairline: "CHAPTER 02 ————". */
export function ChapterLabel({ children, className }) {
  return (
    <div className={cn("flex items-center gap-4", className)}>
      <span className="whitespace-nowrap text-xs uppercase tracking-chapter text-subtle">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-white/10" />
    </div>
  );
}

/** Handwritten tagline above a hero h1 (Handlee 20 -> 24px, ≤ 8 words). */
export function Tagline({ as = "p", tone = "muted", className, children, ...rest }) {
  return createElement(
    as,
    {
      className: cn("font-hand text-xl sm:text-2xl", tone === "soft" ? "text-white/[.82]" : "text-muted-foreground", className),
      ...rest,
    },
    children
  );
}

/** Lead paragraph: 16/28 -> 18/28, muted, max 42rem. */
export function Lead({ as = "p", className, align = "center", children, ...rest }) {
  return createElement(
    as,
    {
      className: cn("max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg", align === "center" && "mx-auto text-center", className),
      ...rest,
    },
    children
  );
}

/**
 * Section head: optional eyebrow, an h2/h3 (tier heading 30 -> 36px, 500), a
 * one-line summary, and a count on the right ("6 courses"), ending in a hairline.
 */
export function SectionHeading({
  as = "h3",
  eyebrow,
  title,
  description,
  aside,
  weight = "medium",
  rule = true,
  className,
  id,
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", rule && "border-b border-white/10 pb-6", className)}>
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="mb-3">{eyebrow}</Eyebrow> : null}
        {createElement(
          as,
          { id, className: cn("text-3xl text-white sm:text-4xl", weight === "semibold" ? "font-semibold" : "font-medium", "leading-[1.11]") },
          title
        )}
        {description ? <p className="mt-3 max-w-2xl text-base text-muted-foreground">{description}</p> : null}
      </div>
      {aside ? <div className="shrink-0 text-sm text-subtle">{aside}</div> : null}
    </div>
  );
}

/** Inner/app page h1 (roadmap, Console, legal): 30 -> 36px, 600, left aligned. */
export function PageTitle({ as = "h1", className, children, ...rest }) {
  return createElement(as, { className: cn("text-3xl font-semibold leading-tight text-white sm:text-4xl", className), ...rest }, children);
}
