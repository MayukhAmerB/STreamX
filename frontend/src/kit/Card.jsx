// Cards (PHILOSOPHY §2.7 catalogue card / feature card / notice; §5 Cards). OWNER: WS-KIT.
//
// Elevation is a 1px white/10 hairline on a near-black surface (#0a0a0a); no
// shadows. Linked cards INVERT on hover and on keyboard focus (M3: surface to
// white, text to black, line art inverted, the ↗ arrow nudges up-right, 300 ms),
// with no lift. On touch screens below md they are shown already inverted,
// because hover does not exist there.
import { Slot } from "@radix-ui/react-slot";
import { createElement, forwardRef } from "react";

import { ArrowUpRight } from "./icons";
import { cn } from "./lib/cn";

export const Card = forwardRef(function Card({ className, tone = "card", asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      ref={ref}
      className={cn(
        "rounded-lg border border-white/10 text-card-foreground",
        tone === "raised" ? "bg-card-raised" : tone === "surface" ? "bg-surface-1" : tone === "transparent" ? "bg-transparent" : "bg-card",
        className
      )}
      {...props}
    />
  );
});

export const CardHeader = forwardRef(function CardHeader({ className, ...props }, ref) {
  return <div ref={ref} className={cn("flex flex-col gap-1.5 p-5 sm:p-6", className)} {...props} />;
});

export const CardTitle = forwardRef(function CardTitle({ as = "h3", className, ...props }, ref) {
  return createElement(as, { ref, className: cn("text-lg font-medium leading-snug text-white", className), ...props });
});

export const CardDescription = forwardRef(function CardDescription({ className, ...props }, ref) {
  return <p ref={ref} className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} />;
});

export const CardContent = forwardRef(function CardContent({ className, ...props }, ref) {
  return <div ref={ref} className={cn("px-5 pb-5 sm:px-6 sm:pb-6", className)} {...props} />;
});

/** Footer link row (T8): hairline top, black strip, label left and an arrow right. */
export const CardFooter = forwardRef(function CardFooter({ className, strip = false, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex items-center justify-between gap-4",
        strip ? "min-h-16 rounded-b-lg border-t border-white/10 bg-black px-5 sm:px-6" : "px-5 pb-5 sm:px-6 sm:pb-6",
        className
      )}
      {...props}
    />
  );
});

/**
 * Classes for a linked, inverting card. Use on an <a>/<Link> wrapper:
 *   <Link className={invertCardClasses()}>…</Link>
 * Children opt in with the `group-…/card` helpers below (title, meta, art, arrow).
 * `touchInverted` (default) shows the white state on touch screens below md.
 */
export function invertCardClasses({ touchInverted = true, framed = false, className } = {}) {
  return cn(
    "group/card relative flex h-full flex-col bg-surface-1 text-white outline-none",
    "transition-colors duration-300 ease-standard motion-reduce:transition-none",
    "hover:bg-white hover:text-black focus-visible:bg-white focus-visible:text-black",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    framed ? "rounded-lg border border-white/10" : "max-md:rounded-lg max-md:border max-md:border-white/10",
    touchInverted && "[@media(hover:none)_and_(max-width:767px)]:bg-white [@media(hover:none)_and_(max-width:767px)]:text-black",
    className
  );
}

/** Text that follows the card inversion: muted on black, black/60 on white. */
export const cardMeta =
  "text-subtle transition-colors duration-300 group-hover/card:text-black/60 group-focus-visible/card:text-black/60 [@media(hover:none)_and_(max-width:767px)]:text-black/60";

/**
 * Line art that inverts with the card. Inline SVG drawn in currentColor
 * already follows the text colour, so only raster/<img> art is inverted
 * (inverting both would cancel out and leave white on white).
 */
export const cardArt =
  "group-hover/card:[&_img]:invert group-focus-visible/card:[&_img]:invert [@media(hover:none)_and_(max-width:767px)]:[&_img]:invert";

/**
 * A status pill that follows the inversion: on the white card it becomes
 * black text on a black/30 hairline (a CSS invert would turn golden white blue).
 */
export const cardStatus = [
  "[&>*]:transition-colors [&>*]:duration-300 motion-reduce:[&>*]:transition-none",
  "group-hover/card:[&>*]:[--icon-knockout:#fff] group-focus-visible/card:[&>*]:[--icon-knockout:#fff] [@media(hover:none)_and_(max-width:767px)]:[&>*]:[--icon-knockout:#fff]",
  "group-hover/card:[&>*]:border-black/30 group-hover/card:[&>*]:bg-transparent group-hover/card:[&>*]:text-black",
  "group-focus-visible/card:[&>*]:border-black/30 group-focus-visible/card:[&>*]:bg-transparent group-focus-visible/card:[&>*]:text-black",
  "[@media(hover:none)_and_(max-width:767px)]:[&>*]:border-black/30 [@media(hover:none)_and_(max-width:767px)]:[&>*]:bg-transparent [@media(hover:none)_and_(max-width:767px)]:[&>*]:text-black",
].join(" ");

/** The ↗ corner arrow: white/30 → black, nudging up-right on hover. */
export function CardArrow({ className }) {
  return (
    <ArrowUpRight
      size={24}
      className={cn(
        "shrink-0 text-white/30 transition-transform duration-300 ease-standard motion-reduce:transition-none",
        "group-hover/card:-translate-y-1 group-hover/card:translate-x-1 group-hover/card:text-black",
        "group-focus-visible/card:text-black [@media(hover:none)_and_(max-width:767px)]:text-black",
        className
      )}
    />
  );
}

/**
 * <LinkCard as={Link} to="/courses/x" title eyebrow description meta action art status>
 * The catalogue/feature card anatomy (PHILOSOPHY §2.7): title + eyebrow + ↗,
 * an art area (16:9), a status pill, then a 3-line description and a meta row.
 */
export const LinkCard = forwardRef(function LinkCard(
  { as: Comp = "a", title, eyebrow, description, meta, action, art, status, framed = false, titleAs = "h3", className, children, ...rest },
  ref
) {
  return (
    <Comp ref={ref} className={invertCardClasses({ framed, className })} {...rest}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6 sm:pt-6">
        <div className="min-w-0">
          {createElement(titleAs, { className: "text-lg font-medium leading-snug" }, title)}
          {eyebrow ? <p className={cn("mt-1 text-eyebrow font-medium uppercase", cardMeta)}>{eyebrow}</p> : null}
        </div>
        <CardArrow />
      </div>
      {art || status ? (
        <div className="relative mt-5 aspect-video">
          {status ? <div className={cn("absolute left-5 top-0 z-[1] sm:left-6", cardStatus)}>{status}</div> : null}
          {art ? <div className={cn("flex h-full items-center justify-center p-6 sm:p-8", cardArt)}>{art}</div> : null}
        </div>
      ) : null}
      {children}
      <div className="mt-auto px-5 pb-5 pt-4 sm:px-6">
        {description ? <p className={cn("line-clamp-3 text-xs leading-5", cardMeta)}>{description}</p> : null}
        {meta || action ? (
          <div className="mt-4 flex items-center justify-between gap-4 text-xs">
            <span className={cardMeta}>{meta}</span>
            {action ? <span className="font-medium opacity-80">{action}</span> : null}
          </div>
        ) : null}
      </div>
    </Comp>
  );
});
