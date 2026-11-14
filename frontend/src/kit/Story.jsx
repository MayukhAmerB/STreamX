// Storytelling primitives: numbered Timeline and Terminal (PHILOSOPHY §2.7
// "Timeline step", T2, M13-M15; BUILD_PLAN §1.4). OWNER: WS-KIT.
//
// The timeline is static, like HackPath's: a 1px white/10 rail, dots that cut
// it (ring-4 black), Handlee numerals with a handwritten period, and real
// product UI under each step. The final step is the emphasised one (white dot
// + soft white glow, white numeral). The terminal can type its lines once it
// scrolls into view (18 ms/char, capped at 2.5 s); reduced motion shows the
// full text at once. The last line is the golden one.
import { forwardRef, useRef } from "react";

import { cn } from "./lib/cn";
import { useInViewOnce, useTypewriter } from "./motion/hooks";

const NEWLINE = String.fromCharCode(10);

/** <Timeline> — an ordered list with the hairline rail. Children are <TimelineStep>s. */
export const Timeline = forwardRef(function Timeline({ className, children, ...rest }, ref) {
  return (
    <ol ref={ref} className={cn("relative space-y-14 border-l border-white/10 pl-8 sm:pl-10", className)} {...rest}>
      {children}
    </ol>
  );
});

/**
 * <TimelineStep number={1} kicker="Week one" title="Find the account" sub="…" last>
 *   <Card>…real product UI…</Card>
 * </TimelineStep>
 */
export const TimelineStep = forwardRef(function TimelineStep(
  { number, kicker, title, sub, last = false, titleAs: TitleTag = "h3", className, children, ...rest },
  ref
) {
  return (
    <li ref={ref} className={cn("relative", className)} {...rest}>
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[2.45rem] top-1.5 size-3 rounded-full ring-4 ring-black sm:-left-[2.95rem]",
          last ? "bg-white shadow-dot-active" : "bg-white/25"
        )}
      />
      {kicker ? <p className="eyebrow">{kicker}</p> : null}
      <div className="mt-3 flex items-baseline gap-3">
        {number !== undefined && number !== null ? (
          <span aria-hidden="true" className={cn("font-hand text-5xl leading-none sm:text-6xl", last ? "text-white" : "text-white/[.82]")}>
            {number}
            <span className="hand-period">.</span>
          </span>
        ) : null}
        <TitleTag className="text-2xl font-semibold leading-tight text-white">
          {number !== undefined && number !== null ? <span className="sr-only">Step {number}: </span> : null}
          {title}
        </TitleTag>
      </div>
      {sub ? <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{sub}</p> : null}
      {children ? <div className="mt-6">{children}</div> : null}
    </li>
  );
});

/**
 * <Terminal title="lab-01 — zsh" lines={["$ whois …", "…"]} typing />
 * A window frame (three white/20 dots, never traffic-light colours), Geist
 * Mono 13 -> 14px. `typing` types the lines once in view; the full text is
 * always in the accessible name (aria-label) so screen readers never hear it
 * character by character.
 */
export function Terminal({ title = "terminal", lines = [], typing = false, className, label }) {
  const ref = useRef(null);
  const inView = useInViewOnce(ref);
  const typed = useTypewriter(lines, { start: typing && inView });
  const shown = typing ? typed.lines : lines;
  const done = typing ? typed.done : true;
  return (
    <figure
      ref={ref}
      className={cn("overflow-hidden rounded-xl border border-white/10 bg-card shadow-window", className)}
      aria-label={label || `${title}: ${lines.join(" / ")}`}
    >
      <figcaption className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-white/20" />
          <span className="size-2.5 rounded-full bg-white/20" />
          <span className="size-2.5 rounded-full bg-white/20" />
        </span>
        <span className="font-mono text-xs text-subtle">{title}</span>
      </figcaption>
      {/* Two layers in one grid cell: the full text (invisible) reserves the
          final height, so typing never shifts the layout (CLS). */}
      <div aria-hidden="true" className="grid overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6 sm:text-sm">
        <pre className="invisible col-start-1 row-start-1 whitespace-pre-wrap font-mono">{lines.join(NEWLINE)}</pre>
        <pre className="col-start-1 row-start-1 whitespace-pre-wrap font-mono text-white/[.82]">
          {shown.map((line, index) => {
            const started = line.length > 0;
            const isLast = index === lines.length - 1;
            const typingHere = !done && started && !(shown[index + 1] || "").length;
            if (!started) return null;
            return (
              <span key={index} className={cn("block", isLast && "text-accent")}>
                {line}
                {typingHere ? <span className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] bg-white/70" /> : null}
              </span>
            );
          })}
        </pre>
      </div>
    </figure>
  );
}

export default Timeline;
