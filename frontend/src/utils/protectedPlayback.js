export function isNestedFullscreenTarget(container, fullscreenElement) {
  if (!container || !fullscreenElement || fullscreenElement === container) {
    return false;
  }

  if (typeof container.contains !== "function") {
    return false;
  }

  return container.contains(fullscreenElement);
}
