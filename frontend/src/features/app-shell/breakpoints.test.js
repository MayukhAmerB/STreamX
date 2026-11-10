import { describe, expect, it } from "vitest";

import { breakpointAtLeast, describeBreakpoint, getBreakpoint } from "./breakpoints";

describe("breakpoints", () => {
  it("maps widths to Carbon breakpoints", () => {
    expect(getBreakpoint(320)).toBe("sm");
    expect(getBreakpoint(360)).toBe("sm");
    expect(getBreakpoint(430)).toBe("sm");
    expect(getBreakpoint(671)).toBe("sm");
    expect(getBreakpoint(672)).toBe("md");
    expect(getBreakpoint(1055)).toBe("md");
    expect(getBreakpoint(1056)).toBe("lg");
    expect(getBreakpoint(1312)).toBe("xlg");
    expect(getBreakpoint(1920)).toBe("max");
  });

  it("falls back to desktop for unknown widths (server render)", () => {
    expect(getBreakpoint(undefined)).toBe("lg");
    expect(getBreakpoint(Number.NaN)).toBe("lg");
  });

  it("uses the bottom nav below lg and the side nav from lg", () => {
    expect(describeBreakpoint("sm")).toMatchObject({ isPhone: true, isDesktop: false, usesBottomNav: true });
    expect(describeBreakpoint("md")).toMatchObject({ isTablet: true, isDesktop: false, usesBottomNav: true });
    expect(describeBreakpoint("lg")).toMatchObject({ isDesktop: true, usesBottomNav: false });
    expect(describeBreakpoint("max").isDesktop).toBe(true);
    expect(breakpointAtLeast("xlg", "lg")).toBe(true);
    expect(breakpointAtLeast("md", "lg")).toBe(false);
  });
});
