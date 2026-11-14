// Motion helpers for the kit (PHILOSOPHY §2.8 / §5, BUILD_PLAN §1.5 + D4). OWNER: WS-KIT.
//
// Rules this module enforces:
// - CSS does everything above the fold. `motion/react` is only for
//   below-the-fold storytelling (timeline demo cards, terminal typing, the
//   plan toggle pill) and its feature pack loads lazily (LazyMotion), so it
//   never lands in the landing entry chunk.
// - Content is present at first paint (HackPath has no section fade-ups):
//   <Reveal> only hides an element that starts BELOW the fold, and only
//   transform + opacity animate.
// - prefers-reduced-motion (or `<html data-motion="reduce">`, used by the
//   gallery and tests) renders the final state, with no movement.
export { prefersReducedMotion, useReducedMotion, useInViewOnce, useTypewriter, REVEAL_EASE, REVEAL_MS, STAGGER_MS, STAGGER_MAX } from "./hooks";
export { LazyMotionProvider, Reveal } from "./Reveal";
