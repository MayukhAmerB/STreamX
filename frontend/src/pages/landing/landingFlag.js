/**
 * VITE_LANDING_V2: the redesigned landing page is ON by default; "off"
 * (or false / 0 / no) serves the previous page for a quick rollback.
 */
export function isLandingV2Enabled(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(text);
}

/**
 * Which landing page to serve (HackPath-philosophy redesign):
 * - default (unset / "on" / "hp" / "v3"): the new black-canvas page;
 * - "v2" / "carbon": the previous Syed Carbon page (instant design rollback);
 * - "off" (false / 0 / no): the original v1 page.
 */
export function landingVariant(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!isLandingV2Enabled(text)) return "v1";
  if (text === "v2" || text === "carbon") return "v2";
  return "hp";
}
