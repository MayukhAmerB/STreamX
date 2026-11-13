/**
 * VITE_LANDING_V2: the redesigned landing page is ON by default; "off"
 * (or false / 0 / no) serves the previous page for a quick rollback.
 */
export function isLandingV2Enabled(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(text);
}
