// "Your recent uploads": one row per upload with its status. OWNER: WS-D1.
import { Link } from "react-router-dom";
import { StatusTag } from "../app-shell/ui";
import { formatBytes, uploadStatusTag } from "./uploadModel";

const formatWhen = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(value))
    : "";

export default function RecentUploads({ items }) {
  return (
    <section className="rup-section" aria-labelledby="rup-recent-title">
      <h2 id="rup-recent-title" className="rup-subtitle">
        Your recent uploads
      </h2>
      {!items.length ? <p className="rup-muted">Nothing uploaded yet. Finished uploads appear here.</p> : null}
      {items.length ? (
        <ul className="rup-list" aria-label="Recent uploads">
          {items.map((item) => {
            const tag = uploadStatusTag(item);
            return (
              <li key={item.id} className="rup-list__item">
                <div className="rup-list__text">
                  <strong className="rup-list__name">{item.filename}</strong>
                  <div className="rup-muted">
                    {[formatBytes(item.total_bytes), item.session_title, formatWhen(item.created_at), item.via_token ? "desktop uploader" : ""]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  {item.error ? <div className="rup-error">{item.error}</div> : null}
                </div>
                <div className="rup-list__end">
                  <StatusTag status={tag.status}>{tag.label}</StatusTag>
                  {item.result?.learn_url ? (
                    <Link className="rup-link" to={item.result.learn_url}>
                      Open
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
