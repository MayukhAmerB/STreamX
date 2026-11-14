// StickyActionBar + useUnsavedChangesGuard (UI overhaul plan §2.5, §2.6 T4). OWNER: WS-A.
// Form actions stuck to the bottom of the form (above the phone bottom nav),
// primary on the right, a quiet "Unsaved changes" note while dirty. The
// guard asks before the tab closes or reloads with unsaved changes.
import { useEffect } from "react";
import "./overhaul.scss";

/** Warns before leaving the page (reload, close, external link) while `dirty`. */
export function useUnsavedChangesGuard(dirty) {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      // Chrome needs returnValue set; the browser shows its own wording.
      event.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
}

export default function StickyActionBar({ primary, secondary = null, dirty = false, note }) {
  return (
    <div className="sc-sticky-actions" data-dirty={dirty ? "true" : "false"}>
      <p className="sc-sticky-actions__note" aria-live="polite">
        {note || (dirty ? "Unsaved changes" : "")}
      </p>
      <div className="sc-sticky-actions__buttons">
        {secondary}
        {primary}
      </div>
    </div>
  );
}
