import { describe, expect, it } from "vitest";

import { getCourseDetailPriceLabel } from "./ProfessionalCoursePage";

describe("getCourseDetailPriceLabel", () => {
  it("formats the admin-controlled course fee on the details page", () => {
    expect(getCourseDetailPriceLabel({ price: 3500 })).toContain("3,500");
  });

  it("does not present a zero price as purchasable", () => {
    expect(getCourseDetailPriceLabel({ price: 0 })).toBe("To be announced");
  });
});
