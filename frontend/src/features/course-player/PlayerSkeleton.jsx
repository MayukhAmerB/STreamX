import { SkeletonPlaceholder, SkeletonText } from "@carbon/react";

/** Loading layout that matches the player (video, title, actions, outline). */
export default function PlayerSkeleton({ desktop = false }) {
  return (
    <div
      className="cp-page cp-page--skeleton"
      data-layout={desktop ? "desktop" : "mobile"}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="cds--visually-hidden">Loading course player</span>
      <div className="cp-layout" aria-hidden="true">
        <div className="cp-main">
          <div className="cp-player">
            <div className="cp-stage">
              <div className="cp-stage__frame">
                <div className="cp-stage__skeleton" />
              </div>
            </div>
          </div>
          <div className="cp-body">
            <SkeletonText heading width="60%" />
            <SkeletonText width="35%" />
            <div className="cp-skeleton-chips">
              {[0, 1, 2, 3].map((chip) => (
                <SkeletonPlaceholder key={chip} className="cp-skeleton-chip" />
              ))}
            </div>
            <SkeletonText paragraph lineCount={3} />
          </div>
        </div>
        {desktop ? (
          <div className="cp-rail">
            <div className="cp-outline">
              <div className="cp-outline__header">
                <SkeletonText heading width="50%" />
                <SkeletonText width="80%" />
              </div>
              <div className="cp-outline__modules cp-skeleton-rail">
                {[0, 1, 2, 3, 4, 5].map((row) => (
                  <SkeletonText key={row} paragraph lineCount={2} />
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
