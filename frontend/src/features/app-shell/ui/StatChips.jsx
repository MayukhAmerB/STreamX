/**
 * Micro-stat chips: a big Inter 800 number over an uppercase micro-label,
 * as one definition list (screen readers hear "Courses 4"). Used by the
 * Console hub and My courses so the two read the same.
 */
export default function StatChips({ items = [], label = "Your progress", className = "" }) {
  if (!items.length) return null;
  return (
    <dl className={`cds-stat-chips${className ? ` ${className}` : ""}`} aria-label={label}>
      {items.map((item) => (
        <div key={item.id} className={`cds-stat-chip${item.accent ? " cds-stat-chip--accent" : ""}`}>
          <dt className="cds-stat-chip__label">{item.label}</dt>
          <dd className="cds-stat-chip__value">
            {item.value}
            {item.suffix ? <span className="cds-stat-chip__suffix">{item.suffix}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Skeleton with the same footprint as the chips. */
export function StatChipsSkeleton({ count = 3 }) {
  return (
    <div className="cds-stat-chips" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="cds-stat-chip cds-stat-chip--skeleton">
          <span className="cds-skeleton-bar cds-skeleton-bar--label" />
          <span className="cds-skeleton-bar cds-skeleton-bar--value" />
        </div>
      ))}
    </div>
  );
}
