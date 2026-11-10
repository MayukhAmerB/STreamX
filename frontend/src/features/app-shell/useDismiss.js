import { useEffect } from "react";

/**
 * Closes a popup (panel, sheet) on Escape or on a pointer press outside the
 * given refs, then returns focus to the trigger for keyboard users.
 */
export function useDismiss({ open, refs, onDismiss, returnFocusRef }) {
  useEffect(() => {
    if (!open) return undefined;

    const dismiss = (restoreFocus) => {
      onDismiss();
      if (restoreFocus) returnFocusRef?.current?.focus?.();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        dismiss(true);
      }
    };

    const handlePointerDown = (event) => {
      const inside = refs.some((ref) => ref.current && ref.current.contains(event.target));
      if (!inside) dismiss(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open, refs, onDismiss, returnFocusRef]);
}
