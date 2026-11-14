// <Reveal> and <LazyMotionProvider> on motion/react (LazyMotion + m). OWNER: WS-KIT.
//
// Reveal (BUILD_PLAN §1.5, PHILOSOPHY §6): opacity 0 -> 1 and y 12 -> 0 in
// 320 ms cubic-bezier(.2,.8,.2,1), once, with a 60 ms stagger (`index`,
// capped at 6). Use it for timeline demo cards only, never whole sections.
// - First render is the FINAL state (server render, no-JS, above the fold).
// - Before paint, an element that starts below the fold is set to the
//   hidden state; it animates in when it scrolls into view.
// - Reduced motion: always the final state, nothing moves.
import { LazyMotion, MotionConfig, m } from "motion/react";
import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";

import { REVEAL_EASE, REVEAL_MS, STAGGER_MAX, STAGGER_MS, useInViewOnce, useReducedMotion } from "./hooks";

// No layout effects on the server (no warning in renderToString).
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const loadFeatures = () => import("./features.js").then((module) => module.default);

/**
 * Wrap a below-the-fold island that uses `m.*` components. The feature pack
 * (~15 KB gz) loads on demand; until it arrives `m.*` render as plain
 * elements in their final state. MotionConfig honours the OS setting.
 */
export function LazyMotionProvider({ children }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

const VARIANTS = {
  hidden: { opacity: 0, y: 12, transition: { duration: 0 } },
  shown: (delay) => ({ opacity: 1, y: 0, transition: { duration: REVEAL_MS / 1000, ease: REVEAL_EASE, delay } }),
};

function startsBelowFold(node) {
  if (!node || typeof window === "undefined" || typeof node.getBoundingClientRect !== "function") return false;
  return node.getBoundingClientRect().top > window.innerHeight;
}

/**
 * <Reveal as="li" index={2}>…</Reveal>
 * `as`: any HTML tag (default "div"). `index`: position in a staggered group.
 */
export function Reveal({ as = "div", index = 0, className, children, ...rest }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const inView = useInViewOnce(ref);
  const [armed, setArmed] = useState(false);

  useIsoLayoutEffect(() => {
    if (!reduced && startsBelowFold(ref.current)) setArmed(true);
  }, [reduced]);

  if (reduced) return createElement(as, { ref, className, ...rest }, children);

  const delay = (Math.min(Math.max(0, index), STAGGER_MAX - 1) * STAGGER_MS) / 1000;
  const Component = m[as] || m.div;
  return (
    <LazyMotionProvider>
      <Component
        ref={ref}
        className={className}
        initial={false}
        animate={armed && !inView ? "hidden" : "shown"}
        variants={VARIANTS}
        custom={delay}
        {...rest}
      >
        {children}
      </Component>
    </LazyMotionProvider>
  );
}

export default Reveal;
