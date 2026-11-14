// A compact audit feed (Admin home "Recent activity" and the Activity page).
// OWNER: WS-G. Rows: who · what · which record · when (relative, exact on hover).
import { ArrowRight } from "@carbon/icons-react";
import { ago, dateTime } from "./format";
import SmartLink from "./SmartLink";

const VERBS = { added: "added", changed: "changed", deleted: "deleted" };

function describe(entry) {
  const message = String(entry.message || "").trim();
  if (message && message !== "No fields changed.") return message.replace(/\.$/, "");
  return `${VERBS[entry.action] || "changed"} ${entry.model ? entry.model.toLowerCase() : "a record"}`;
}

export default function ActivityList({ entries = [], now = new Date(), showGroup = false, compact = false }) {
  return (
    <ol className={`adm-activity${compact ? " adm-activity--compact" : ""}`}>
      {entries.map((entry) => (
        <li key={entry.id} className="adm-activity__row">
          <div className="adm-activity__main">
            <p className="adm-activity__what">
              <span className="adm-activity__actor">{entry.actor?.name || entry.actor?.email || "Someone"}</span>{" "}
              <span className="adm-activity__verb">{describe(entry)}</span>
            </p>
            <p className="adm-activity__object">
              {entry.href ? (
                <SmartLink href={entry.href} className="adm-link">
                  {entry.object}
                </SmartLink>
              ) : (
                <span>{entry.object}</span>
              )}
              {entry.model ? <span className="adm-activity__model"> · {entry.model}</span> : null}
              {showGroup && entry.group_label ? <span className="adm-activity__model"> · {entry.group_label}</span> : null}
            </p>
          </div>
          <time className="adm-activity__when" dateTime={entry.at} title={dateTime(entry.at)}>
            {ago(entry.at, now)}
          </time>
        </li>
      ))}
    </ol>
  );
}

export function ActivityMoreLink() {
  return (
    <SmartLink href="/console/admin/activity" className="adm-link adm-link--arrow">
      All activity <ArrowRight size={16} aria-hidden="true" />
    </SmartLink>
  );
}
