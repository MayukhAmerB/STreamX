export function isNestedFullscreenTarget(container, fullscreenElement) {
  if (!container || !fullscreenElement || fullscreenElement === container) {
    return false;
  }

  if (typeof container.contains !== "function") {
    return false;
  }

  return container.contains(fullscreenElement);
}

const FULLSCREEN_LAYOUT_TOKEN_PATTERN = /(^|:)(aspect-|min-h-|max-h-)/;

export function normalizeProtectedPlaybackClassName(className = "", isFullscreen = false) {
  const normalized = String(className || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!isFullscreen) {
    return normalized.join(" ");
  }

  return normalized.filter((token) => !FULLSCREEN_LAYOUT_TOKEN_PATTERN.test(token)).join(" ");
}
