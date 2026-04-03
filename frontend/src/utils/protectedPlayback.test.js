import { describe, expect, it } from "vitest";

import { isNestedFullscreenTarget, normalizeProtectedPlaybackClassName } from "./protectedPlayback";

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

describe("normalizeProtectedPlaybackClassName", () => {
  it("preserves the original layout classes outside fullscreen", () => {
    expect(normalizeProtectedPlaybackClassName("aspect-video w-full min-h-[260px]", false)).toBe(
      "aspect-video w-full min-h-[260px]"
    );
  });

  it("removes aspect and height constraints inside fullscreen", () => {
    expect(
      normalizeProtectedPlaybackClassName(
        "aspect-video w-full min-h-[260px] sm:min-h-[360px] lg:max-h-[calc(100vh-220px)]",
        true
      )
    ).toBe("w-full");
  });
});
