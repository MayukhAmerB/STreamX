import { Tile } from "@carbon/react";

/** Empty state: icon + one sentence + one action. */
export default function EmptyState({ icon: Icon, text, action }) {
  return (
    <Tile className="cds-empty-state">
      {Icon ? <Icon size={48} aria-hidden="true" /> : null}
      <p className="cds-empty-state__text">{text}</p>
      {action || null}
    </Tile>
  );
}
