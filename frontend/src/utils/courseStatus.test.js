import { describe, expect, it } from "vitest";

import { getCourseLaunchStatus } from "./courseStatus";

describe("getCourseLaunchStatus", () => {
  it("returns live when backend launch status is live", () => {
    const result = getCourseLaunchStatus({ launch_status: "live" });
    expect(result).toMatchObject({ key: "live", isLive: true, isComingSoon: false });
  });

  it("returns coming soon when backend launch status is coming_soon", () => {
    const result = getCourseLaunchStatus({ launch_status: "coming_soon" });
    expect(result).toMatchObject({ key: "coming_soon", isLive: false, isComingSoon: true });
  });
});
