// Small shared pieces of the Admin workspace. OWNER: WS-G.
import { Search } from "@carbon/icons-react";
import { openCommandPalette } from "../command-palette";

/** Section heading with the one eyebrow pattern (32×2 rule + label). */
export function SectionHeading({ id, children, action = null }) {
  return (
    <div className="adm-section__head">
      <h2 id={id} className="adm-section__title">
        <span className="adm-eyebrow-rule" aria-hidden="true" />
        {children}
      </h2>
      {action}
    </div>
  );
}

export function isMacLike() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Looks like a search field; opens the Ctrl/Cmd+K palette. */
export function CommandField({ placeholder = "Search people, courses, payments, or type an action", shortPlaceholder = "Search or type an action" }) {
  const mac = isMacLike();
  return (
    <button
      type="button"
      className="adm-command"
      onClick={() => openCommandPalette()}
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
      aria-label={`${placeholder} (${mac ? "Command" : "Control"} K)`}
    >
      <Search size={20} aria-hidden="true" className="adm-command__icon" />
      <span className="adm-command__text adm-command__text--long">{placeholder}</span>
      <span className="adm-command__text adm-command__text--short">{shortPlaceholder}</span>
      <span className="adm-command__keys" aria-hidden="true">
        <kbd>{mac ? "⌘" : "Ctrl"}</kbd>
        <kbd>K</kbd>
      </span>
    </button>
  );
}

/** Static skeleton blocks with the final footprint (shown only after 300 ms by the caller). */
export function SkeletonBlocks({ count = 3, className = "adm-skeleton-tile", label = "Loading" }) {
  return (
    <div className="adm-skeleton" role="status" aria-busy="true">
      <span className="cds--visually-hidden">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={className} aria-hidden="true" />
      ))}
    </div>
  );
}
