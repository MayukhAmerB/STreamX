// One shell dialog at a time. The Console shell has three once-only moments:
// the "Your journey so far" welcome (legacy students), the "choose your
// handle" prompt and the level-up moment. A dialog that wants the screen
// `hold`s its name; a dialog may open only when no name EARLIER in
// DIALOG_ORDER is held, so the journey goes first, then the handle prompt,
// then the level-up moment. Releasing a name lets the next one open.
import { useSyncExternalStore } from "react";

export const DIALOG_ORDER = Object.freeze(["journey", "handle", "levelup"]);

let held = new Set();
const listeners = new Set();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Claim the screen for `name`. `silent` mutates without notifying (safe during
 * render: a component rendered earlier in the tree claims before later
 * siblings read their turn in the same pass).
 */
export function holdDialog(name, { silent = false } = {}) {
  if (held.has(name)) return;
  held = new Set(held).add(name);
  if (!silent) emit();
}

export function releaseDialog(name) {
  if (!held.has(name)) return;
  const next = new Set(held);
  next.delete(name);
  held = next;
  emit();
}

/** True when no dialog earlier in DIALOG_ORDER holds the screen. */
export function dialogTurn(name, current = held) {
  const index = DIALOG_ORDER.indexOf(name);
  if (index < 0) return true;
  return DIALOG_ORDER.slice(0, index).every((earlier) => !current.has(earlier));
}

export function useDialogTurn(name) {
  const read = () => dialogTurn(name);
  return useSyncExternalStore(subscribe, read, read);
}

/** Test helper. */
export function resetDialogQueue() {
  held = new Set();
  emit();
}
