// OWNER: WS-G. The palette listens for this window event; anything can open it.
export const COMMAND_PALETTE_OPEN_EVENT = "command-palette:open";

export function openCommandPalette({ initialQuery = "" } = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, { detail: { initialQuery } }));
}
