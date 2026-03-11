import { describe, expect, it } from "vitest";

import { formatINR } from "./currency";

describe("formatINR", () => {
  it("formats numbers as INR currency", () => {
    const formatted = formatINR(3000);
    expect(formatted).toContain("3,000");
    expect(formatted).toMatch(/₹|INR/);
  });
});
