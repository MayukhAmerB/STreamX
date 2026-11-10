import { describe, expect, it } from "vitest";
import {
  COMPACT_CONTROLS_MAX_WIDTH,
  formatPlaybackRate,
  formatPlaybackTime,
  formatSeekValueText,
  getNextPlaybackRate,
  getProgressPercent,
  isLiveDuration,
  isMostlyInViewport,
  normalizePlaybackRates,
  resolveControlsLayout,
} from "./playbackControls";

describe("playback control helpers", () => {
  it("formats times like video players do", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(7.9)).toBe("0:07");
    expect(formatPlaybackTime(1080)).toBe("18:00");
    expect(formatPlaybackTime(3723)).toBe("1:02:03");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
    expect(formatPlaybackTime(-5)).toBe("0:00");
    expect(formatSeekValueText(83, 1080)).toBe("1:23 of 18:00");
  });

  it("cycles through the allowed speeds and wraps around", () => {
    expect(getNextPlaybackRate([1, 1.5, 2], 1)).toBe(1.5);
    expect(getNextPlaybackRate([1, 1.5, 2], 1.5)).toBe(2);
    expect(getNextPlaybackRate([1, 1.5, 2], 2)).toBe(1);
    // An unknown current speed restarts at the first option.
    expect(getNextPlaybackRate([1, 1.5, 2], 0.75)).toBe(1);
    expect(getNextPlaybackRate([], 1)).toBe(1);
  });

  it("cleans up rate lists and labels them", () => {
    expect(normalizePlaybackRates([1, "1.5", 1, -2, "x", 2])).toEqual([1, 1.5, 2]);
    expect(normalizePlaybackRates(null)).toEqual([1, 1.5, 2]);
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(1.5)).toBe("1.5x");
    expect(formatPlaybackRate(0.75)).toBe("0.75x");
    expect(formatPlaybackRate(0)).toBe("1x");
  });

  it("recognises live streams and computes progress", () => {
    expect(isLiveDuration(Infinity)).toBe(true);
    expect(isLiveDuration(1080)).toBe(false);
    expect(isLiveDuration(Number.NaN)).toBe(false);
    expect(getProgressPercent(540, 1080)).toBe(50);
    expect(getProgressPercent(2000, 1080)).toBe(100);
    expect(getProgressPercent(10, 0)).toBe(0);
  });

  it("uses the touch layout on narrow players and touch screens", () => {
    expect(resolveControlsLayout({ width: 360 })).toBe("touch");
    expect(resolveControlsLayout({ width: COMPACT_CONTROLS_MAX_WIDTH })).toBe("desktop");
    expect(resolveControlsLayout({ width: 900, coarsePointer: true })).toBe("touch");
    // Not measured yet (no ResizeObserver): desktop bar.
    expect(resolveControlsLayout({ width: 0 })).toBe("desktop");
  });

  it("only treats a mostly visible player as on screen", () => {
    expect(isMostlyInViewport({ top: 0, bottom: 200, height: 200 }, 800)).toBe(true);
    expect(isMostlyInViewport({ top: -150, bottom: 50, height: 200 }, 800)).toBe(false);
    expect(isMostlyInViewport({ top: 750, bottom: 950, height: 200 }, 800)).toBe(false);
    expect(isMostlyInViewport({ top: 700, bottom: 900, height: 200 }, 800)).toBe(true);
    expect(isMostlyInViewport(null, 800)).toBe(false);
  });
});
