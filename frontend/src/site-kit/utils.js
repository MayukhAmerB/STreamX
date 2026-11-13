import { useEffect, useState } from "react";

/** Joins truthy class names. */
export function cx(...names) {
  return names.filter(Boolean).join(" ");
}

/** True for links that leave the single-page app (other origins, mail, phone). */
export function isExternalHref(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(String(href || ""));
}

/** True when the visitor asked the OS for reduced motion (false outside a browser). */
export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/**
 * `active` delayed by `delayMs`: false until `active` has stayed true for the
 * whole delay, so fast responses never flash a loading state (plan §7.2 rule 6).
 */
export function useDelayedFlag(active, delayMs = 300) {
  const [shown, setShown] = useState(Boolean(active) && delayMs <= 0);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return undefined;
    }
    if (delayMs <= 0) {
      setShown(true);
      return undefined;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return Boolean(active) && shown;
}

/** Activation keys for elements that behave like links or buttons. */
export function isActivationKey(event) {
  return event?.key === "Enter" || event?.key === " " || event?.key === "Spacebar";
}
