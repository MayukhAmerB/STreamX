import { useEffect, useRef, useState } from "react";

/**
 * Height (px) of the on-screen keyboard overlapping the layout viewport,
 * from `visualViewport`. iOS Safari and recent Chrome keep fixed elements
 * on the layout viewport, so a bottom-docked composer would sit behind the
 * keyboard without this. 0 when unsupported or closed.
 */
export function useKeyboardInset(active = true) {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (!active || typeof window === "undefined" || !window.visualViewport) {
      setInset(0);
      return undefined;
    }
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const overlap = window.innerHeight - viewport.height - viewport.offsetTop;
        setInset(overlap > 60 ? Math.round(overlap) : 0);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [active]);

  return inset;
}

/** Live border-box height of an element (0 until measured). */
export function useElementHeight(ref, active = true) {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize ?? entry?.contentRect?.height ?? 0;
      setHeight(Math.round(size));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);

  return height;
}

/**
 * Counts down from `seconds` while `running`; calls `onDone` once at zero.
 * Returns the seconds left.
 */
export function useCountdown(running, seconds, onDone) {
  const [left, setLeft] = useState(seconds);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    setLeft(seconds);
    if (!running) return undefined;
    const startedAt = Date.now();
    let finished = false;
    const timer = setInterval(() => {
      const remaining = Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000));
      setLeft(remaining);
      if (remaining === 0 && !finished) {
        finished = true;
        clearInterval(timer);
        onDoneRef.current?.();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [running, seconds]);

  return left;
}
