import { SkeletonPlaceholder, SkeletonText } from "@carbon/react";

/**
 * Carbon loading skeleton for a page: header block + tiles (or form rows).
 * `label` is announced to screen readers while content loads.
 */
export default function PageSkeleton({ variant = "tiles", count = 3, label = "Loading" }) {
  return (
    <div className="cds-page-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">{label}</span>
      <div className="cds-page-skeleton__header" aria-hidden="true">
        <SkeletonText heading width="40%" />
        <SkeletonText width="60%" />
      </div>
      {variant === "form" ? (
        <div className="cds-page-skeleton__tile" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <SkeletonText key={index} paragraph lineCount={2} width="70%" />
          ))}
        </div>
      ) : (
        <div className="cds-tile-grid" aria-hidden="true">
          {Array.from({ length: count }, (_, index) => (
            <div key={index} className="cds-page-skeleton__tile">
              <SkeletonPlaceholder style={{ width: "100%", height: "9rem" }} />
              <SkeletonText heading width="70%" />
              <SkeletonText paragraph lineCount={2} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
