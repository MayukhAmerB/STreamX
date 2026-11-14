// EmptyState v2 (UI overhaul plan §2.5, Appendix A.5). OWNER: WS-A.
// A 32 px Carbon icon, one sentence, an optional second line and ONE action
// that leads somewhere (never a dead end). `text` is the v1 name of `title`.

/**
 * Empty state: icon + one sentence + one action.
 * EmptyState({ icon, title, body?, action? }); `action` is a rendered node (a Button or Link).
 */
export default function EmptyState({ icon: Icon, text, title, body, action }) {
  return (
    <section className="cds-empty-state" role="status">
      {Icon ? <Icon size={32} aria-hidden="true" className="cds-empty-state__icon" /> : null}
      <p className="cds-empty-state__text">{title || text}</p>
      {body ? <p className="cds-empty-state__body">{body}</p> : null}
      {action ? <div className="cds-empty-state__action">{action}</div> : null}
    </section>
  );
}
