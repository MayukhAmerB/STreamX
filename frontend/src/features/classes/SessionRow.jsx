// One class in the Classes list: status, what it is, ONE primary action,
// "Copy link" as a ghost and everything else (danger last) in the overflow
// menu. Danger items never act directly: the page confirms first.
// OWNER: WS-D1.
import { Copy } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { StatusTag } from "../app-shell/ui";
import RowOverflowMenu from "./RowOverflowMenu";
import { canManageSession, sessionModeLabel, sessionRowActions, sessionStatus } from "./classesModel";

function metaLine(session) {
  const course = session?.linked_course?.title || session?.linked_live_class?.linked_course_title || "";
  const liveClass = session?.linked_live_class?.title || "";
  return [sessionModeLabel(session), liveClass, course && course !== liveClass ? course : ""].filter(Boolean).join(" · ");
}

export default function SessionRow({ session, user, busy = false, accent = false, onAction }) {
  const status = sessionStatus(session);
  const actions = sessionRowActions(session, user);
  const titleId = `cls-row-${session.id}-title`;
  return (
    <li className="cls-row" data-session-id={session.id} aria-labelledby={titleId}>
      <div className="cls-row__main">
        <div className="cls-row__status">
          <StatusTag status={status.key}>{status.label}</StatusTag>
        </div>
        <h3 id={titleId} className="cls-row__title">
          {session.title}
        </h3>
        <p className="cls-row__meta">{metaLine(session)}</p>
        {session.description ? <p className="cls-row__description">{session.description}</p> : null}
      </div>
      <div className="cls-row__actions">
        <Button
          kind="primary"
          size="md"
          className={accent ? "sc-button--accent cls-accent cls-row__primary" : "cls-row__primary"}
          disabled={busy}
          onClick={() => onAction(actions.primary.key, session)}
        >
          {actions.primary.label}
        </Button>
        {actions.copyLink ? (
          <Button kind="ghost" size="md" renderIcon={Copy} className="cls-row__copy" onClick={() => onAction("copy", session)}>
            <span className="cls-row__copy-label">Copy link</span>
          </Button>
        ) : null}
        <RowOverflowMenu
          label={`More actions for ${session.title}`}
          items={actions.overflow}
          disabled={busy}
          onSelect={(key) => onAction(key, session)}
        />
      </div>
      {!canManageSession(session, user) ? <p className="cls-row__note">You can watch this class. Only its host can run it.</p> : null}
    </li>
  );
}
