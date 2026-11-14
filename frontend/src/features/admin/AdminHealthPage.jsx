// /console/admin/system/health (plan §4.3). OWNER: WS-G.
// One question: "is anything broken in the background?" A calm all-clear
// when nothing failed; otherwise the failed outbox events and background
// jobs with Retry (one or all), plus the server-profile agent.
import { CheckmarkFilled, Launch, Renew, WarningAltFilled } from "@carbon/icons-react";
import { useState } from "react";
import { apiData, apiMessage } from "../../utils/api";
import { ErrorState, PageHeader, StatusTag, useSkeletonGate, useToast } from "../app-shell/ui";
import { SectionHeading, SkeletonBlocks } from "./AdminBits";
import { fetchHealth, retryHealth } from "./api";
import { ago, dateTime, plural } from "./format";
import SmartLink from "./SmartLink";
import useAdminData from "./useAdminData";
import "./admin.scss";

function FailureList({ kind, block, busy, onRetry, label, empty }) {
  if (!block) return null;
  return (
    <section className="adm-section" aria-labelledby={`adm-health-${kind}`}>
      <SectionHeading
        id={`adm-health-${kind}`}
        action={
          block.count && block.can_retry ? (
            <button type="button" className="adm-button adm-button--secondary" disabled={Boolean(busy)} onClick={() => onRetry(kind)}>
              <Renew size={16} aria-hidden="true" />
              {busy === `${kind}:all` ? "Retrying…" : `Retry all ${block.count}`}
            </button>
          ) : null
        }
      >
        {label}
      </SectionHeading>
      {block.count ? (
        <ul className="adm-failures">
          {block.items.map((item) => (
            <li key={item.id} className="adm-failure">
              <div className="adm-failure__main">
                <p className="adm-failure__title">
                  <StatusTag status="failed" />
                  <span>{item.title}</span>
                </p>
                {item.error ? <p className="adm-failure__error">{item.error}</p> : null}
                <p className="adm-failure__meta">
                  {plural(item.attempts, "attempt")} · <time dateTime={item.created_at} title={dateTime(item.created_at)}>{ago(item.created_at)}</time> ·{" "}
                  <SmartLink href={item.href} className="adm-link">
                    Details
                  </SmartLink>
                </p>
              </div>
              {block.can_retry ? (
                <button type="button" className="adm-button adm-button--ghost" disabled={Boolean(busy)} onClick={() => onRetry(kind, [item.id])} aria-label={`Retry ${item.title} #${item.id}`}>
                  {busy === `${kind}:${item.id}` ? "Retrying…" : "Retry"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="adm-quiet adm-ok">
          <CheckmarkFilled size={16} aria-hidden="true" className="adm-clear__icon" /> {empty}
          {block.pending ? ` ${plural(block.pending, "item")} waiting to run.` : ""}
        </p>
      )}
    </section>
  );
}

function ServerProfile({ profile }) {
  if (!profile) return null;
  return (
    <section className="adm-section" aria-labelledby="adm-health-server">
      <SectionHeading id="adm-health-server">Server profile</SectionHeading>
      {profile.configured ? (
        <dl className="adm-facts">
          <div className="adm-facts__row">
            <dt>Agent</dt>
            <dd>
              <StatusTag status={profile.agent_online ? "on" : "off"}>{profile.agent_online ? "Online" : "Offline"}</StatusTag>
              {profile.agent_last_seen_at ? <span className="adm-facts__aside"> last seen {ago(profile.agent_last_seen_at)}</span> : null}
            </dd>
          </div>
          <div className="adm-facts__row">
            <dt>Profile</dt>
            <dd>
              {profile.profile}
              {profile.in_sync ? "" : " (applying…)"}
            </dd>
          </div>
          <div className="adm-facts__row">
            <dt>Status</dt>
            <dd>{profile.status_label}</dd>
          </div>
          {profile.agent_error ? (
            <div className="adm-facts__row">
              <dt>Last error</dt>
              <dd>{profile.agent_error}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="adm-quiet">The server-profile agent has not reported yet.</p>
      )}
      <SmartLink href={profile.href || "/admin/realtime/serverresourceprofile/"} className="adm-link adm-link--arrow">
        Change the server profile <Launch size={16} aria-hidden="true" />
      </SmartLink>
    </section>
  );
}

export default function AdminHealthPage() {
  const health = useAdminData(fetchHealth, { pollMs: 60 * 1000 });
  const phase = useSkeletonGate(health.loading && !health.data);
  const [busy, setBusy] = useState("");
  const { showToast } = useToast();
  const data = health.data;

  const retry = async (kind, ids) => {
    setBusy(`${kind}:${ids ? ids[0] : "all"}`);
    try {
      const result = apiData(await retryHealth(kind, ids), {});
      showToast({
        kind: result.retried ? "success" : "info",
        title: result.retried ? `${plural(result.retried, kind === "outbox" ? "event" : "job")} queued again` : "Nothing to retry",
        subtitle: result.retried ? "The worker picks them up within a minute." : "They were already retried.",
      });
      health.reload({ quiet: true });
    } catch (error) {
      showToast({ kind: "error", title: "Retry failed", subtitle: apiMessage(error, "Try again."), timeout: 8000 });
    } finally {
      setBusy("");
    }
  };

  let body;
  if (health.error && !data) body = <ErrorState error={health.error} onRetry={() => health.reload()} />;
  else if (!data) body = phase === "skeleton" ? <SkeletonBlocks count={3} className="adm-skeleton-row" label="Checking the system" /> : <div className="adm-skeleton adm-skeleton--waiting" />;
  else {
    const nothingVisible = !data.failed_outbox && !data.failed_jobs && !data.server_profile;
    body = (
      <>
        <div className={`adm-health-summary${data.problems ? " adm-health-summary--attention" : ""}`} role="status">
          {data.problems ? (
            <WarningAltFilled size={24} aria-hidden="true" className="adm-health-summary__icon" />
          ) : (
            <CheckmarkFilled size={24} aria-hidden="true" className="adm-health-summary__icon" />
          )}
          <div>
            <p className="adm-health-summary__title">{data.problems ? `${plural(data.problems, "problem")} to look at` : "Everything is running"}</p>
            <p className="adm-health-summary__sub">Checked {ago(data.checked_at) || "just now"}. This page refreshes every minute.</p>
          </div>
        </div>
        {nothingVisible ? <p className="adm-quiet">Your account cannot see the system records. Ask a superuser for access.</p> : null}
        <FailureList kind="outbox" block={data.failed_outbox} busy={busy} onRetry={retry} label="Failed side effects (outbox)" empty="No failed events." />
        <FailureList kind="job" block={data.failed_jobs} busy={busy} onRetry={retry} label="Failed background jobs" empty="No failed jobs." />
        <ServerProfile profile={data.server_profile} />
        <p className="adm-quiet">
          <SmartLink href={data.insights_href || "/admin/dashboard/"} className="adm-link adm-link--arrow">
            Open the insights dashboard <Launch size={16} aria-hidden="true" />
          </SmartLink>
        </p>
      </>
    );
  }

  return (
    <div className="adm-page adm-page--narrow">
      <PageHeader title="Health" description="Failed background work and the server, at a glance." eyebrow={null} breadcrumbs={[{ label: "System" }, { label: "Health" }]} />
      {body}
    </div>
  );
}
