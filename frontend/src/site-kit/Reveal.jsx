import { useEffect, useRef, useState } from "react";

import { cx, prefersReducedMotion } from "./utils";

/**
 * Expressive entrance (240 ms), at most once, when the element scrolls into
 * view (plan §7.1 motion). Content is visible by default: nothing is hidden
 * on the server, without JavaScript or IntersectionObserver, under reduced
 * motion, or when the element is already on screen at mount. Only content
 * that starts below the fold is held back until it enters the viewport.
 */
export function useReveal() {
  const ref = useRef(null);
  const [state, setState] = useState("static");

  useEffect(() => {
    const node = ref.current;
    if (!node || prefersReducedMotion() || typeof IntersectionObserver === "undefined") return undefined;
    const viewport = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
    const top = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect().top : 0;
    if (!viewport || top < viewport) return undefined; // already visible: never animate, never hide
    setState("pending");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("in");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, "data-reveal": state === "static" ? undefined : state };
}

export default function Reveal({ as: Element = "div", className, children, ...rest }) {
  const { ref, ...revealProps } = useReveal();
  return (
    <Element ref={ref} className={cx("sk-reveal", className)} {...revealProps} {...rest}>
      {children}
    </Element>
  );
}
