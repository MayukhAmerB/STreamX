// PageSkeleton (UI overhaul plan §2.5, M3). OWNER: WS-A.
// Appears only after 300 ms (fast answers never flash a skeleton), keeps the
// final footprint (no layout shift), shimmers with a transform at most 3
// times and then rests. `useSkeletonGate` also keeps a shown skeleton for at
// least 250 ms so it never flickers.
import { useEffect, useRef, useState } from "react";
import { useDelayedFlag } from "../../../site-kit/utils";

const SKELETON_DELAY_MS = 300;
const SKELETON_MIN_MS = 250;

/**
 * `"wait" | "skeleton" | "content"` for a loading region: nothing for the
 * first 300 ms, then the skeleton for at least 250 ms, then the content.
 */
export function useSkeletonGate(loading) {
  const [phase, setPhase] = useState(loading ? "wait" : "content");
  const shownAt = useRef(0);
  useEffect(() => {
    if (loading) {
      if (phase === "content") setPhase("wait");
      if (phase !== "wait") return undefined;
      const timer = setTimeout(() => {
        shownAt.current = Date.now();
        setPhase("skeleton");
      }, SKELETON_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "skeleton") {
      const left = SKELETON_MIN_MS - (Date.now() - shownAt.current);
      if (left > 0) {
        const timer = setTimeout(() => setPhase("content"), left);
        return () => clearTimeout(timer);
      }
    }
    if (phase !== "content") setPhase("content");
    return undefined;
  }, [loading, phase]);
  return phase;
}

function Bar({ width = "100%", height = "0.75rem", className = "" }) {
  return <span className={`cds-skeleton-bar ${className}`.trim()} style={{ inlineSize: width, blockSize: height }} />;
}

/**
 * Loading skeleton for a page: header block + tiles, rows or form rows.
 * `label` is announced to screen readers while content loads; `delay={false}`
 * shows it at once (when the caller already waited).
 */
export default function PageSkeleton({ variant = "tiles", count = 3, label = "Loading", delay = true }) {
  const visible = useDelayedFlag(true, delay ? SKELETON_DELAY_MS : 0);
  if (!visible) return <div className="cds-page-skeleton cds-page-skeleton--waiting" role="status" aria-busy="true" aria-label={label} />;
  return (
    <div className="cds-page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">{label}</span>
      <div className="cds-page-skeleton__header" aria-hidden="true">
        <Bar width="min(24rem, 60%)" height="2rem" />
        <Bar width="min(32rem, 80%)" height="1rem" />
      </div>
      {variant === "form" ? (
        <div className="cds-page-skeleton__tile cds-page-skeleton__form" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="cds-page-skeleton__field">
              <Bar width="8rem" height="0.75rem" />
              <Bar width="100%" height="2.5rem" />
            </div>
          ))}
        </div>
      ) : variant === "rows" ? (
        <div className="cds-page-skeleton__rows" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="cds-page-skeleton__row">
              <Bar width="40%" height="1rem" />
              <Bar width="20%" height="0.75rem" />
            </div>
          ))}
        </div>
      ) : (
        <div className="cds-tile-grid" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="cds-page-skeleton__tile">
              <Bar width="100%" height="9rem" />
              <Bar width="70%" height="1.25rem" />
              <Bar width="90%" />
              <Bar width="60%" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
