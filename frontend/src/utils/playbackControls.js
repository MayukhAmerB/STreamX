// Pure helpers for the shared video control bar (ProtectedPlaybackSurface).
// Kept free of React and the DOM so they can be unit tested in plain Node.

/** Controls fade out after this long without interaction while playing. */
export const CONTROLS_AUTO_HIDE_MS = 3000;

/** Below this player width the touch layout (centre play cluster) is used. */
export const COMPACT_CONTROLS_MAX_WIDTH = 560;

export const DEFAULT_PLAYBACK_RATES = [1, 1.5, 2];

/** "0:07", "18:00", "1:02:03". */
export function formatPlaybackTime(totalSeconds) {
  const normalized = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Screen-reader value for the seek slider: "1:23 of 18:00". */
export function formatSeekValueText(currentSeconds, durationSeconds) {
  return `${formatPlaybackTime(currentSeconds)} of ${formatPlaybackTime(durationSeconds)}`;
}

/** Valid, unique, positive playback rates in the given order. */
export function normalizePlaybackRates(rates) {
  const source = Array.isArray(rates) ? rates : DEFAULT_PLAYBACK_RATES;
  return source
    .map((rate) => Number(rate))
    .filter((rate, index, list) => Number.isFinite(rate) && rate > 0 && list.indexOf(rate) === index);
}

/** The rate after `current` (wrapping), for a single cycling speed button. */
export function getNextPlaybackRate(rates, current) {
  const list = normalizePlaybackRates(rates);
  if (list.length === 0) return 1;
  const index = list.findIndex((rate) => Math.abs(rate - Number(current)) < 0.01);
  return list[(index + 1) % list.length];
}

/** "1x", "1.5x", "0.75x". */
export function formatPlaybackRate(rate) {
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return "1x";
  return `${Number(value.toFixed(2))}x`;
}

/** Live HLS streams report an infinite duration. */
export function isLiveDuration(duration) {
  return duration === Infinity;
}

/** Played share of the video, 0-100. */
export function getProgressPercent(currentSeconds, durationSeconds) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const current = Math.max(0, Number(currentSeconds) || 0);
  return Math.min(100, (current / duration) * 100);
}

/**
 * Touch layout (play / back 10 / forward 10 in the centre, like phone video
 * apps) for narrow players or touch-only devices; desktop layout otherwise.
 */
export function resolveControlsLayout({ width = 0, coarsePointer = false } = {}) {
  const measured = Number(width) || 0;
  if (coarsePointer) return "touch";
  if (measured > 0 && measured < COMPACT_CONTROLS_MAX_WIDTH) return "touch";
  return "desktop";
}

/** True when at least `ratio` of the element's height is inside the viewport. */
export function isMostlyInViewport(rect, viewportHeight, ratio = 0.4) {
  if (!rect || !(rect.height > 0) || !(viewportHeight > 0)) return false;
  const visible = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
  return visible / rect.height >= ratio;
}
