// M20 "Capability reveal" (plan §2.3): when a workspace turns from disabled to
// enabled during a session (an admin switched Teaching on), its nav entry
// enters once and carries a small "New" dot until the user opens it.
// OWNER: WS-F. Pure bookkeeping; WS-B renders the dot.
import { useCallback, useEffect, useState } from "react";

export const CAPABILITY_REVEAL_EVENT = "capabilities:reveal";
const STORAGE_PREFIX = "sc.caps.new.";
const previous = { userId: null, states: {} };

function storageKey(workspace) {
  return `${STORAGE_PREFIX}${workspace}`;
}

function readFlag(workspace) {
  try {
    return window.sessionStorage.getItem(storageKey(workspace)) === "1";
  } catch {
    return false;
  }
}

function writeFlag(workspace, value) {
  try {
    if (value) {
      window.sessionStorage.setItem(storageKey(workspace), "1");
    } else {
      window.sessionStorage.removeItem(storageKey(workspace));
    }
  } catch {
    // Private mode / blocked storage: the dot simply does not persist.
  }
}

/** Records the viewer's workspace states; flags any that went disabled -> enabled. Returns the newly enabled keys. */
export function noteCapabilities(userId, caps) {
  if (userId !== previous.userId) {
    previous.userId = userId;
    previous.states = {};
  }
  const revealed = [];
  const workspaces = caps?.workspaces || {};
  Object.entries(workspaces).forEach(([key, entry]) => {
    const state = entry?.state;
    if (previous.states[key] === "disabled" && state === "enabled") {
      revealed.push(key);
      if (typeof window !== "undefined") {
        writeFlag(key, true);
      }
    }
    if (state) {
      previous.states[key] = state;
    }
  });
  if (revealed.length && typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(CAPABILITY_REVEAL_EVENT, { detail: { workspaces: revealed } }));
  }
  return revealed;
}

/** Test helper. */
export function resetCapabilityReveal() {
  previous.userId = null;
  previous.states = {};
}

/**
 * `{ isNew, clear }` for a workspace ("teach"): `isNew` is true from the moment
 * it was switched on in this session until `clear()` (call it on first visit).
 */
export function useCapabilityReveal(workspace) {
  const [isNew, setIsNew] = useState(() => (typeof window === "undefined" ? false : readFlag(workspace)));

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const onReveal = (event) => {
      if (event?.detail?.workspaces?.includes(workspace)) {
        setIsNew(true);
      }
    };
    window.addEventListener(CAPABILITY_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(CAPABILITY_REVEAL_EVENT, onReveal);
  }, [workspace]);

  const clear = useCallback(() => {
    writeFlag(workspace, false);
    setIsNew(false);
  }, [workspace]);

  return { isNew, clear };
}
