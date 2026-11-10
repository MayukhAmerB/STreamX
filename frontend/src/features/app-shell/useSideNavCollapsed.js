import { useCallback, useState } from "react";

export const SIDE_NAV_STORAGE_KEY = "console.sidenav.collapsed";

/** Reads the viewer's saved choice; storage can be blocked or throw. */
export function readSideNavCollapsed(storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    return store?.getItem(SIDE_NAV_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSideNavCollapsed(collapsed, storage) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (!store) return;
    if (collapsed) store.setItem(SIDE_NAV_STORAGE_KEY, "1");
    else store.removeItem(SIDE_NAV_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: the choice just isn't remembered.
  }
}

/**
 * Desktop side nav: full width (default) or a collapsed icon rail. The
 * choice is a per-viewer convenience kept in localStorage.
 */
export function useSideNavCollapsed() {
  const [collapsed, setCollapsed] = useState(() => readSideNavCollapsed());
  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      writeSideNavCollapsed(next);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}
