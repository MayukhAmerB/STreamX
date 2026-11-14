// /console/admin/activity: every change made by admins, newest first
// (plan §4.3). OWNER: WS-G. Same LogEntry history as the back office,
// filtered by the 8 admin job groups, loaded 30 at a time.
import { Activity } from "@carbon/icons-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiData, apiMessage } from "../../utils/api";
import { EmptyState, ErrorState, PageHeader, Toolbar, useSkeletonGate } from "../app-shell/ui";
import ActivityList from "./ActivityList";
import { SkeletonBlocks } from "./AdminBits";
import { ADMIN_GROUPS } from "./adminSitemap";
import { fetchActivity } from "./api";
import useAdminData from "./useAdminData";
import "./admin.scss";

export default function AdminActivityPage() {
  const [params, setParams] = useSearchParams();
  const groupKeys = ADMIN_GROUPS.filter((group) => group.key !== "today").map((group) => group.key);
  const group = groupKeys.includes(params.get("group")) ? params.get("group") : "";
  const list = useAdminData(() => fetchActivity({ group }), { deps: [group] });
  const phase = useSkeletonGate(list.loading && !list.data);
  const [more, setMore] = useState({ rows: [], next: null, loading: false, error: "" });

  useEffect(() => {
    setMore({ rows: [], next: list.data?.next_before ?? null, loading: false, error: "" });
  }, [list.data]);

  const loadMore = () => {
    if (!more.next) return;
    setMore((current) => ({ ...current, loading: true, error: "" }));
    fetchActivity({ group, before: more.next })
      .then((response) => {
        const data = apiData(response, {});
        setMore((current) => ({ rows: [...current.rows, ...(data.results || [])], next: data.next_before ?? null, loading: false, error: "" }));
      })
      .catch((error) => setMore((current) => ({ ...current, loading: false, error: apiMessage(error, "More activity could not be loaded.") })));
  };

  const setGroup = (key) => {
    const next = new URLSearchParams(params);
    if (key) next.set("group", key);
    else next.delete("group");
    setParams(next, { replace: true });
  };

  const chips = [{ key: "", label: "Everything" }, ...ADMIN_GROUPS.filter((item) => item.key !== "today")].map((item) => ({
    key: item.key || "all",
    label: item.label,
    active: item.key === group,
    onClick: () => setGroup(item.key),
  }));
  const rows = [...(list.data?.results || []), ...more.rows];

  let body;
  if (list.error && !list.data) body = <ErrorState error={list.error} onRetry={() => list.reload()} />;
  else if (!list.data) body = phase === "skeleton" ? <SkeletonBlocks count={6} className="adm-skeleton-row" label="Loading activity" /> : <div className="adm-skeleton adm-skeleton--waiting" />;
  else if (!rows.length)
    body = (
      <EmptyState
        icon={Activity}
        title={group ? "Nothing changed in this group yet." : "No admin changes yet."}
        body="Approvals, publishing, switches and back-office edits appear here."
        action={
          group ? (
            <button type="button" className="adm-link adm-link--button" onClick={() => setGroup("")}>
              Show everything
            </button>
          ) : (
            <a className="adm-link" href="/admin/">
              Open the back office
            </a>
          )
        }
      />
    );
  else
    body = (
      <>
        <ActivityList entries={rows} showGroup={!group} />
        {more.error ? <ErrorState error={more.error} onRetry={loadMore} /> : null}
        {more.next ? (
          <div className="adm-more">
            <button type="button" className="adm-button adm-button--secondary" onClick={loadMore} disabled={more.loading}>
              {more.loading ? "Loading…" : "Show older"}
            </button>
          </div>
        ) : null}
      </>
    );

  return (
    <div className="adm-page adm-page--narrow">
      <PageHeader title="Activity" description="Every change made by admins, newest first." eyebrow={null} />
      {list.data?.scope === "mine" ? <p className="adm-quiet">You see your own changes. Superusers see everyone&apos;s.</p> : null}
      <Toolbar chips={chips} label="Activity filters" />
      {body}
    </div>
  );
}
