// The landing page's Watch section anchor (kept tiny: the navbar imports it).
export const WATCH_SECTION_ID = "watch";

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/** Smoothly scrolls to the Watch section (the header offset comes from its scroll-margin); false when absent. */
export function scrollToWatchSection() {
  if (typeof document === "undefined") return false;
  const element = document.getElementById(WATCH_SECTION_ID);
  if (!element) return false;
  element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  return true;
}

/** Smoothly scrolls to any element by id (scroll-margin handles the header); false when absent. */
export function scrollToSection(id) {
  if (typeof document === "undefined" || !id) return false;
  const element = document.getElementById(id);
  if (!element) return false;
  element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  return true;
}
