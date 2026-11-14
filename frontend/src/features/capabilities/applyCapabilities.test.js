import { describe, expect, it } from "vitest";
import capabilities from "../../__contracts__/ui-overhaul/capabilities.json";
import applyCapabilities, { CHECKING_REASON, resolveCapability } from "./applyCapabilities";

const REASON = "Teaching tools are switched off for now. An admin can turn them on.";

describe("applyCapabilities", () => {
  it("leaves ungated items enabled, even before capabilities load", () => {
    expect(applyCapabilities([{ id: "home" }], null)).toEqual([{ id: "home", state: "enabled", reason: "" }]);
  });

  it("keeps gated items disabled with 'Checking…' until capabilities load (never flashes enabled)", () => {
    const [item] = applyCapabilities([{ id: "teach", workspace: "teach" }], null);
    expect(item).toMatchObject({ state: "disabled", reason: CHECKING_REASON });
  });

  it.each([
    ["student", "hidden", ""],
    ["instructor_off", "disabled", REASON],
    ["instructor_on", "enabled", ""],
    ["staff_off", "hidden", ""],
  ])("resolves the Teach workspace for %s", (variant, state, reason) => {
    expect(resolveCapability({ workspace: "teach" }, capabilities[variant])).toEqual({ state, reason });
    expect(resolveCapability({ capability: "teach-grading" }, capabilities[variant])).toEqual({ state, reason });
  });

  it("falls back to the feature flag when only a feature is named", () => {
    expect(resolveCapability({ feature: "teaching", disabledReason: "Off" }, capabilities.instructor_off)).toEqual({ state: "disabled", reason: "Off" });
    expect(resolveCapability({ feature: "teaching" }, capabilities.instructor_on)).toEqual({ state: "enabled", reason: "" });
  });

  it("never drops items and keeps their other fields", () => {
    const items = applyCapabilities([{ id: "a", label: "A" }, { id: "b", capability: "teach-today" }], capabilities.student);
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe("A");
    expect(items[1].state).toBe("hidden");
  });
});
