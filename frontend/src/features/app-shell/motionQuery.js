// True when the OS or the viewer's "Reduce motion" choice asks for less
// motion (plan §1.7). Plain function for event handlers and effects; React
// components use useReducedMotion() from site-kit/motion.
export function prefersReducedMotion() {
  if (typeof window === "undefined") return true;
  if (document.documentElement?.getAttribute("data-motion") === "reduce") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}
