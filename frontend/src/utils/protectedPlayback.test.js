import { describe, expect, it } from "vitest";

import { isNestedFullscreenTarget } from "./protectedPlayback";

describe("isNestedFullscreenTarget", () => {
  it("returns false when fullscreen is already on the protected container", () => {
    const container = {
      contains(target) {
        return target === this;
      },
    };

    expect(isNestedFullscreenTarget(container, container)).toBe(false);
  });

  it("returns true when a nested playback element enters fullscreen", () => {
    const child = { id: "video" };
    const container = {
      contains(target) {
        return target === child;
      },
    };

    expect(isNestedFullscreenTarget(container, child)).toBe(true);
  });

  it("returns false when the fullscreen element is outside the protected surface", () => {
    const child = { id: "video" };
    const other = { id: "outside" };
    const container = {
      contains(target) {
        return target === child;
      },
    };

    expect(isNestedFullscreenTarget(container, other)).toBe(false);
  });
});
