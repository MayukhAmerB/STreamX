// Syed Carbon motion kit (UI overhaul plan §2.2-§2.5, Appendix A.5). OWNER: WS-A.
// CSS + WAAPI + View Transitions + about 2 KB of helpers; no runtime
// dependencies. Only transform and opacity animate, and every helper renders
// its final state under reduced motion (OS setting or the Profile toggle,
// `data-motion="reduce"` on <html>).
//
//   useReveal (existing) · useInViewOnce · useCountUp · useFlip · useStagger
//   navigateWithTransition · useReducedMotion · setMotionPreference
//   <LiveDot state> · <CountUp value format> · <RollingDigits value> · <Meter value label>
import { initMotionPreference } from "./hooks";

export { useReveal } from "../Reveal";
export {
  getMotionPreference,
  initMotionPreference,
  navigateWithTransition,
  prefersReducedMotionNow,
  resetCountUpMemory,
  setMotionPreference,
  useCountUp,
  useFlip,
  useInViewOnce,
  useReducedMotion,
  useStagger,
} from "./hooks";
export { CountUp, LiveDot, Meter, RollingDigits } from "./components";

// Apply the Profile "Reduce motion" choice as soon as the kit loads.
initMotionPreference();
