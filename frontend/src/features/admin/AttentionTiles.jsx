// "Needs attention" tiles + the calm "All clear" line (plan §4.4). OWNER: WS-G.
// One tile per waiting queue (count, age of the oldest item, one action);
// queues at zero collapse into a single line; hidden queues (count null)
// are not shown at all. Only the busiest tile's button is champagne.
import {
  Activity,
  Chat,
  CheckmarkFilled,
  ChevronRight,
  CloudUpload,
  Currency,
  Flag,
  Report,
  Security,
  UserFollow,
  UserMultiple,
  VideoChat,
  Wallet,
  WarningAltFilled,
} from "@carbon/icons-react";
import { CountUp, useStagger } from "../../site-kit/motion";
import { actionLabel, busiestKey, clearLine, splitQueues } from "./attentionModel";
import { shortAge } from "./format";
import SmartLink from "./SmartLink";

export const QUEUE_ICONS = {
  enrolment_requests: UserFollow,
  reports_to_grade: Report,
  recordings_to_review: VideoChat,
  uploads_failed: CloudUpload,
  payments_to_action: Wallet,
  exams_to_publish: Flag,
  leads: UserMultiple,
  flagged_content: Chat,
  quarantined_files: Security,
  system_issues: Activity,
  plans_awaiting_price: Currency,
};

function AttentionTile({ queue, accent, fresh, enter, now, onVisit }) {
  const Icon = QUEUE_ICONS[queue.key] || Activity;
  const age = shortAge(queue.oldest_at, now);
  const high = queue.severity === "high";
  return (
    <li className={`adm-tile${accent ? " adm-tile--busiest" : ""}`} data-queue={queue.key} {...enter}>
      <div className="adm-tile__head">
        <Icon size={20} aria-hidden="true" className="adm-tile__icon" />
        <h3 className="adm-tile__label">{queue.label}</h3>
        {fresh ? <span className="adm-new-dot" role="img" aria-label="New since you looked" /> : null}
      </div>
      <p className="adm-tile__count">
        <CountUp value={Number(queue.count)} sessionKey={`admin-attention:${queue.key}`} />
        <span className="cds--visually-hidden"> waiting</span>
      </p>
      <p className={`adm-tile__meta${high ? " adm-tile__meta--high" : ""}`}>
        {high ? <WarningAltFilled size={16} aria-hidden="true" className="adm-tile__warn" /> : null}
        <span>{age ? (age === "just now" ? "Just in" : `Oldest ${age}`) : "Waiting"}</span>
      </p>
      <SmartLink
        href={queue.href}
        className={`adm-button ${accent ? "adm-button--accent" : "adm-button--secondary"} adm-tile__action`}
        aria-label={`${actionLabel(queue)}: ${queue.label}`}
        onClick={() => onVisit?.(queue.key)}
      >
        <span className="adm-tile__action-text">{actionLabel(queue)}</span>
        <ChevronRight size={20} aria-hidden="true" className="adm-tile__chevron" />
      </SmartLink>
    </li>
  );
}

export default function AttentionTiles({ queues = [], freshKeys = [], now = new Date(), onVisit }) {
  const { waiting, clear } = splitQueues(queues);
  const busiest = busiestKey(waiting);
  const enter = useStagger(true);
  const line = clearLine(clear);
  return (
    <div className="adm-attention">
      {waiting.length ? (
        <ul className="adm-tiles" aria-label="Waiting for you">
          {waiting.map((queue, index) => (
            <AttentionTile
              key={queue.key}
              queue={queue}
              accent={queue.key === busiest}
              fresh={freshKeys.includes(queue.key)}
              enter={enter(index)}
              now={now}
              onVisit={onVisit}
            />
          ))}
        </ul>
      ) : null}
      {line ? (
        <p className={`adm-clear${waiting.length ? "" : " adm-clear--all"}`} data-testid="attention-all-clear">
          <CheckmarkFilled size={16} aria-hidden="true" className="adm-clear__icon" />
          <span>{waiting.length ? line : "Everything is up to date. " + line}</span>
        </p>
      ) : null}
    </div>
  );
}
