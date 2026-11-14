// A quiet "this scrolls sideways" cue for wide tables (UI overhaul plan §2.5,
// ResponsiveTable scroll cue). OWNER: WS-D2. Sets data-cue on the scroll box:
// "end" while more columns hide on the right, "start" when scrolled to the
// end, absent when everything fits. CSS draws the fade (Grading.scss,
// Exams.scss). Pass `selector` when the scroll box is a child of the element
// the ref goes on (e.g. ResponsiveTable's `.sc-table-scroll`).
import { useEffect, useRef } from "react";

export function scrollCue({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 } = {}) {
  if (scrollWidth <= clientWidth + 1) return "";
  return scrollLeft + clientWidth >= scrollWidth - 1 ? "start" : "end";
}

export default function useScrollCue(selector = "") {
  const ref = useRef(null);
  useEffect(() => {
    const host = ref.current;
    if (!host || typeof window === "undefined") return undefined;
    const box = () => (selector ? host.querySelector(selector) : host);
    const update = () => {
      const node = box();
      if (!node) return;
      const cue = scrollCue(node);
      if (cue) node.setAttribute("data-cue", cue);
      else node.removeAttribute("data-cue");
    };
    update();
    // Scroll events do not bubble; a capturing listener on the host sees the child's.
    host.addEventListener("scroll", update, { capture: true, passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(host);
    window.addEventListener("resize", update);
    return () => {
      host.removeEventListener("scroll", update, { capture: true });
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [selector]);
  return ref;
}
