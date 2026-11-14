// Syed Carbon motion components (UI overhaul plan §2.3, Appendix A.5). OWNER: WS-A.
// Shared by the public site and the Console: tokens only, no Carbon.
import { useEffect, useRef, useState } from "react";
import { useCountUp, useInViewOnce, useReducedMotion } from "./hooks";
import "./motion.css";

/**
 * The one live indicator (M8). `state`: "live" | "reconnecting". The ring
 * pings 3 times, then rests (WCAG 2.2.2); it pings again when the state turns
 * live or the tab becomes visible. Reconnecting is an amber dot with no ping.
 * Pass `label` to announce it; otherwise it is decorative (pair it with a word).
 */
export function LiveDot({ state = "live", label }) {
  const [cycle, setCycle] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = () => {
      if (!document.hidden) setCycle((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return (
    <span
      key={`${state}-${cycle}`}
      className={`sc-live-dot sc-live-dot--${state}`}
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : "true"}
    />
  );
}

function formatted(value, format) {
  if (typeof format === "function") return format(value);
  if (typeof value === "number") return value.toLocaleString();
  return String(value ?? "");
}

/**
 * Count-up number (M5): counts from 0 the first time it is half in view,
 * once per `sessionKey` per session (owner decision D6). Screen readers hear
 * the final value once (the moving digits are aria-hidden); tabular figures
 * and a fixed minimum width stop any layout shift.
 */
export function CountUp({ value, format, sessionKey, className = "" }) {
  const [ref, seen] = useInViewOnce({ threshold: 0.5 });
  const shown = useCountUp(value, { start: seen, sessionKey });
  const finalText = formatted(value, format);
  const animating = shown !== value;
  return (
    <span ref={ref} className={`sc-count-up ${className}`.trim()} style={{ minInlineSize: `${finalText.length}ch` }}>
      {animating ? (
        <>
          <span aria-hidden="true">{formatted(shown, format)}</span>
          <span className="sc-visually-hidden">{finalText}</span>
        </>
      ) : (
        finalText
      )}
    </span>
  );
}

/**
 * Digits where only the changed character rolls (M9): the old one leaves
 * upward, the new one rises in (moderate-02, standard-expressive) inside a
 * one-line window. The first render and reduced motion just swap.
 */
export function RollingDigits({ value, className = "" }) {
  const text = String(value ?? "");
  const previous = useRef(null);
  const reduced = useReducedMotion();
  const before = previous.current;
  useEffect(() => {
    previous.current = text;
  }, [text]);
  const chars = [...text];
  const old = before == null ? null : [...before];
  const aligned = old && old.length === chars.length ? old : null;
  return (
    <span className={`sc-rolling-digits ${className}`.trim()}>
      <span className="sc-visually-hidden">{text}</span>
      <span aria-hidden="true">
        {chars.map((char, index) => {
          const was = aligned ? aligned[index] : char;
          const changed = !reduced && was !== char;
          return (
            // Index keys are deliberate: the cell stays, its character changes.
            <span key={index} className="sc-rolling-digits__cell">
              {changed ? (
                <span key={`out-${was}-${char}`} className="sc-rolling-digits__char sc-rolling-digits__char--out">
                  {was}
                </span>
              ) : null}
              <span key={`in-${char}`} className={`sc-rolling-digits__char${changed ? " sc-rolling-digits__char--in" : ""}`}>
                {char === " " ? " " : char}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}

/**
 * Progress meter (M6). `value` 0..1. The fill is `transform: scaleX(p)` from
 * the left, filling once (slow-01) the first time it is in view; complete
 * turns it green. `accent` marks the screen's one champagne meter.
 */
export function Meter({ value = 0, label, accent = false, className = "" }) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  const [ref, seen] = useInViewOnce({ threshold: 0.3 });
  const reduced = useReducedMotion();
  const scale = seen || reduced ? clamped : 0;
  const classes = ["sc-meter", accent ? "sc-meter--accent" : "", clamped >= 1 ? "sc-meter--done" : "", className].filter(Boolean).join(" ");
  return (
    <div
      ref={ref}
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <span className="sc-meter__fill" style={{ transform: `scaleX(${scale})` }} />
    </div>
  );
}
