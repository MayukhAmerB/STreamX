// YouTube-style keyboard shortcuts for the lecture player (pure resolver).
//   K / Space  play-pause      J / L  back / forward 10s
//   ← / →      back / forward 5s   M  mute      F  fullscreen
//   Shift+N    next lesson      Shift+P  previous lesson

export const PLAYER_SHORTCUTS = [
  { keys: ["K", "Space"], label: "Play / pause" },
  { keys: ["J", "L"], label: "Back / forward 10 seconds" },
  { keys: ["←", "→"], label: "Back / forward 5 seconds" },
  { keys: ["M"], label: "Mute / unmute" },
  { keys: ["F"], label: "Fullscreen" },
  { keys: ["Shift+N", "Shift+P"], label: "Next / previous lesson" },
];

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
// Widgets that use arrows/space themselves (tabs, sliders, menus...).
const ARROW_KEY_ROLES = new Set([
  "tab",
  "slider",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "option",
  "radio",
  "switch",
  "combobox",
  "listbox",
  "textbox",
  "spinbutton",
  "tree",
  "treeitem",
  "grid",
]);
const ACTIVATABLE_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

function attribute(target, name) {
  return typeof target?.getAttribute === "function" ? target.getAttribute(name) : null;
}

export function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || "").toUpperCase();
  if (TEXT_ENTRY_TAGS.has(tag)) return true;
  return attribute(target, "role") === "textbox";
}

/**
 * Maps a keydown event to a player action, or null when the key belongs to
 * something else (typing, a focused tab list, a modifier shortcut...).
 * Actions: "toggle-play" | "seek" (with `seconds`) | "mute" | "fullscreen" | "next" | "previous"
 */
export function resolvePlayerShortcut(event) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const target = event.target;
  if (isTextEntryTarget(target)) return null;

  const tag = String(target?.tagName || "").toUpperCase();
  const role = attribute(target, "role");
  const key = String(event.key || "");

  if (event.shiftKey) {
    if (key === "N" || key === "n") return { action: "next" };
    if (key === "P" || key === "p") return { action: "previous" };
    return null;
  }

  switch (key) {
    case "k":
    case "K":
      return { action: "toggle-play" };
    case " ":
    case "Spacebar":
      // Space activates focused buttons/links natively; leave those alone.
      if (ACTIVATABLE_TAGS.has(tag) || (role && ARROW_KEY_ROLES.has(role))) return null;
      return { action: "toggle-play" };
    case "j":
    case "J":
      return { action: "seek", seconds: -10 };
    case "l":
    case "L":
      return { action: "seek", seconds: 10 };
    case "ArrowLeft":
    case "ArrowRight":
      if (role && ARROW_KEY_ROLES.has(role)) return null;
      return { action: "seek", seconds: key === "ArrowLeft" ? -5 : 5 };
    case "m":
    case "M":
      return { action: "mute" };
    case "f":
    case "F":
      return { action: "fullscreen" };
    default:
      return null;
  }
}
