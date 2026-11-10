// Carbon Design System breakpoints (px). Kept in sync with
// @carbon/layout: sm 20rem, md 42rem, lg 66rem, xlg 82rem, max 99rem.
export const CARBON_BREAKPOINTS = [
  { name: "sm", min: 0 },
  { name: "md", min: 672 },
  { name: "lg", min: 1056 },
  { name: "xlg", min: 1312 },
  { name: "max", min: 1584 },
];

/** The side nav is persistent from Carbon's `lg` breakpoint upwards. */
export const DESKTOP_SHELL_MIN_WIDTH = 1056;

/** Name of the Carbon breakpoint for a viewport width in CSS pixels. */
export function getBreakpoint(width) {
  const value = Number(width);
  if (!Number.isFinite(value) || value < 0) return "lg";
  let current = CARBON_BREAKPOINTS[0].name;
  for (const breakpoint of CARBON_BREAKPOINTS) {
    if (value >= breakpoint.min) current = breakpoint.name;
  }
  return current;
}

export function breakpointAtLeast(name, minimum) {
  const order = CARBON_BREAKPOINTS.map((breakpoint) => breakpoint.name);
  return order.indexOf(name) >= order.indexOf(minimum);
}

/** Derived layout flags used by the shell. */
export function describeBreakpoint(name) {
  const isDesktop = breakpointAtLeast(name, "lg");
  return {
    name,
    isDesktop,
    isTablet: name === "md",
    isPhone: name === "sm",
    // Phones and tablets get the app-style bottom navigation.
    usesBottomNav: !isDesktop,
  };
}
