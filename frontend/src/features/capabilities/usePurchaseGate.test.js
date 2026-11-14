import { describe, expect, it } from "vitest";

import { PURCHASE_STATES, resolvePurchaseGate } from "./usePurchaseGate";

const REASON = "Pentesting is coming soon. You can browse every course now; enrolment opens at launch.";

describe("resolvePurchaseGate", () => {
  it("reads the course purchase_gate", () => {
    const gate = resolvePurchaseGate({ category: "web_pentesting", purchase_gate: { state: "coming_soon", code: "feature_disabled", reason: REASON } });
    expect(gate).toEqual({ state: "coming_soon", code: "feature_disabled", reason: REASON, disabled: true });
  });

  it("reads a catalogue card purchase block and a plan state", () => {
    expect(resolvePurchaseGate({ track: "osint", purchase: { state: "available", code: "", reason: "" } }).disabled).toBe(false);
    const plan = resolvePurchaseGate({ key: "ctf_labs_monthly", group: "osint", state: "coming_soon", code: "price_unconfirmed", reason: "Opens once the price is confirmed." });
    expect(plan).toMatchObject({ state: "coming_soon", disabled: true, reason: "Opens once the price is confirmed." });
  });

  it("capabilities disable Pentesting even when the payload is stale", () => {
    const caps = { items: { "pentesting-purchase": { state: "disabled", reason: REASON } } };
    const gate = resolvePurchaseGate({ category: "web_pentesting", purchase_gate: { state: "available" } }, caps);
    expect(gate).toMatchObject({ state: PURCHASE_STATES.COMING_SOON, code: "feature_disabled", disabled: true, reason: REASON });
  });

  it("falls back to the legacy purchase fields", () => {
    expect(resolvePurchaseGate({ category: "osint", purchase_available: true }).disabled).toBe(false);
    expect(resolvePurchaseGate({ category: "osint", purchase_available: false, purchase_unavailable_reason: "registration_closed" }))
      .toMatchObject({ state: "unavailable", disabled: true, code: "registration_closed" });
    expect(resolvePurchaseGate({ category: "web_pentesting", purchase_available: false, purchase_unavailable_reason: "feature_disabled" }))
      .toMatchObject({ state: "coming_soon", reason: REASON });
  });

  it("an unknown Pentesting state is treated as closed (disable, never hide)", () => {
    expect(resolvePurchaseGate({ category: "web_pentesting" })).toMatchObject({ state: "coming_soon", disabled: true });
    expect(resolvePurchaseGate(null)).toMatchObject({ disabled: true });
  });

  it("enabled capability lets an available Pentesting course through", () => {
    const caps = { items: { "pentesting-purchase": { state: "enabled" } } };
    expect(resolvePurchaseGate({ category: "web_pentesting" }, caps).disabled).toBe(false);
  });
});
