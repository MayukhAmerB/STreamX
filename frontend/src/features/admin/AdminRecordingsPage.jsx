// /console/admin/recordings: ONE list over class recordings, raw meeting
// recordings and uploads (plan §4.3). OWNER: WS-G. Filters: Needs review ·
// Failed · Processing · Published. A row opens the review panel
// (`?open=<id>` deep link): player when the file is playable, why it needs
// review, what went wrong, and the actions (Mark reviewed, Publish/Hide,
// Retry) that run the same services as the back office.
import { ChevronRight, Launch, VideoChat, WarningAltFilled } from "@carbon/icons-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiData, apiMessage } from "../../utils/api";
import { EmptyState, ErrorState, PageHeader, ScrollTabs, SidePanel, StatusTag, useSidePanelParam, useSkeletonGate, useToast } from "../app-shell/ui";
import { SkeletonBlocks } from "./AdminBits";
import { actOnRecording, fetchRecording, fetchRecordings } from "./api";
import { ago, dateTime, plural } from "./format";
import SmartLink from "./SmartLink";
import useAdminData from "./useAdminData";
import "./admin.scss";

export const RECORDING_FILTERS = [
  { key: "", label: "All" },
  { key: "needs_review", label: "Needs review" },
  { key: "failed", label: "Failed" },
  { key: "processing", label: "Processing" },
  { key: "published", label: "Published" },
];

const ACTION_LABELS = {
  mark_reviewed: "Mark reviewed",
  publish: "Publish lecture",
  unpublish: "Hide lecture",
  retry: "Retry",
};

function RecordingRow({ item, active, onOpen }) {
  return (
    <li className={`adm-recording${active ? " is-active" : ""}`}>
      <button type="button" className="adm-recording__button" onClick={() => onOpen(item.id)} aria-label={`Review ${item.title}`}>
        <span className="adm-recording__main">
          <span className="adm-recording__title">{item.title}</span>
          <span className="adm-recording__sub">
            {[item.source_label, item.subtitle].filter(Boolean).join(" · ")}
          </span>
        </span>
        <span className="adm-recording__tags">
          {item.needs_review ? <StatusTag status="due">Needs review</StatusTag> : null}
          <StatusTag status={item.status}>{item.status === "draft" || item.status === "off" ? item.state_label : undefined}</StatusTag>
        </span>
        <time className="adm-recording__when" dateTime={item.created_at} title={dateTime(item.created_at)}>
          {ago(item.created_at)}
        </time>
        <ChevronRight size={16} aria-hidden="true" className="adm-recording__chevron" />
      </button>
    </li>
  );
}

export function RecordingPanelBody({ item, loading, error }) {
  if (error) return <ErrorState error={error} />;
  if (!item) return loading ? <SkeletonBlocks count={2} className="adm-skeleton-row" label="Loading recording" /> : null;
  return (
    <div className="adm-panel">
      {item.media_url ? (
        // Staff-only media view of the back office (Range requests, same session).
        <video className="adm-panel__video" src={item.media_url} controls preload="metadata" />
      ) : null}
      <div className="adm-panel__status">
        <StatusTag status={item.status}>{item.state_label}</StatusTag>
        {item.needs_review ? <StatusTag status="due">Needs review</StatusTag> : null}
      </div>
      {item.needs_review && item.review_reason ? (
        <p className="adm-panel__note">
          <strong>Why review:</strong> {item.review_reason}
        </p>
      ) : null}
      {item.error ? (
        <p className="adm-panel__note adm-panel__note--error">
          <WarningAltFilled size={16} aria-hidden="true" />
          <span>{item.error}</span>
        </p>
      ) : null}
      <dl className="adm-facts">
        {(item.facts || []).map((fact) => (
          <div key={fact.label} className="adm-facts__row">
            <dt>{fact.label}</dt>
            <dd>{fact.label === "Started" || fact.label === "Ended" ? dateTime(fact.value) : fact.value}</dd>
          </div>
        ))}
        <div className="adm-facts__row">
          <dt>Added</dt>
          <dd>{dateTime(item.created_at)}</dd>
        </div>
      </dl>
      {!Object.values(item.actions || {}).some(Boolean) ? (
        <p className="adm-quiet">Nothing to do here in the Console. The back office has every detail.</p>
      ) : null}
      {item.links?.class_details ? (
        <SmartLink href={item.links.class_details} className="adm-link adm-link--arrow">
          Edit topic, module and description
        </SmartLink>
      ) : null}
      {item.links?.back_office ? (
        <SmartLink href={item.links.back_office} className="adm-link adm-link--arrow">
          Open in the back office <Launch size={16} aria-hidden="true" />
        </SmartLink>
      ) : null}
    </div>
  );
}

export default function AdminRecordingsPage() {
  const [params, setParams] = useSearchParams();
  const filter = RECORDING_FILTERS.some((item) => item.key === params.get("filter")) ? params.get("filter") || "" : "";
  const [openId, setOpenId] = useSidePanelParam("open");
  const { showToast } = useToast();
  const list = useAdminData(() => fetchRecordings({ filter }), { deps: [filter] });
  const phase = useSkeletonGate(list.loading && !list.data);
  const [detail, setDetail] = useState({ id: null, item: null, loading: false, error: "" });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!openId) {
      setDetail({ id: null, item: null, loading: false, error: "" });
      return undefined;
    }
    let live = true;
    const fromList = (list.data?.results || []).find((row) => row.id === openId) || null;
    setDetail({ id: openId, item: fromList, loading: true, error: "" });
    fetchRecording(openId)
      .then((response) => live && setDetail({ id: openId, item: apiData(response, null), loading: false, error: "" }))
      .catch((error) => live && setDetail({ id: openId, item: null, loading: false, error: apiMessage(error, "This recording could not be loaded.") }));
    return () => {
      live = false;
    };
    // The list is only a quick first paint for the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const setFilter = (key) => {
    const next = new URLSearchParams(params);
    if (key) next.set("filter", key);
    else next.delete("filter");
    next.delete("open");
    setParams(next);
  };

  const runAction = useCallback(
    async (action) => {
      if (!detail.id) return;
      setBusy(action);
      try {
        const response = await actOnRecording(detail.id, action);
        const data = apiData(response, {});
        if (data.item) {
          setDetail((current) => ({ ...current, item: data.item }));
          list.setData((current) =>
            current ? { ...current, results: current.results.map((row) => (row.id === data.item.id ? { ...row, ...data.item, media_url: row.media_url } : row)) } : current
          );
        }
        showToast({ kind: "success", title: data.message || "Saved" });
        list.reload({ quiet: true });
      } catch (error) {
        showToast({ kind: "error", title: "That did not work", subtitle: apiMessage(error, "Try again."), timeout: 8000 });
      } finally {
        setBusy("");
      }
    },
    [detail.id, list, showToast]
  );

  const counts = list.data?.counts || {};
  const tabs = RECORDING_FILTERS.map((item) => ({
    key: item.key || "all",
    label: item.label,
    badge: item.key && item.key !== "published" && counts[item.key] ? counts[item.key] : undefined,
    onClick: () => setFilter(item.key),
  }));
  const rows = list.data?.results || [];
  const item = detail.item;
  const actions = item?.actions || {};
  const available = ["mark_reviewed", "publish", "unpublish", "retry"].filter((key) => actions[key]);
  const footer =
    item && available.length ? (
      <div className="adm-panel__footer">
        {available.map((key, index) => (
          <button
            key={key}
            type="button"
            className={`adm-button ${index === 0 ? "adm-button--primary" : "adm-button--secondary"}`}
            disabled={Boolean(busy)}
            onClick={() => runAction(key)}
          >
            {busy === key ? "Working…" : ACTION_LABELS[key]}
          </button>
        ))}
      </div>
    ) : null;

  let body;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => list.reload()} />;
  } else if (!list.data) {
    body = phase === "skeleton" ? <SkeletonBlocks count={5} className="adm-skeleton-row" label="Loading recordings" /> : <div className="adm-skeleton adm-skeleton--waiting" />;
  } else if (!rows.length) {
    const empty = {
      needs_review: "No recordings need review.",
      failed: "Nothing has failed.",
      processing: "Nothing is processing right now.",
      published: "No published recordings yet.",
      "": "No recordings yet.",
    }[filter];
    body = (
      <EmptyState
        icon={VideoChat}
        title={empty}
        body="New class recordings appear here after each class."
        action={
          filter ? (
            <button type="button" className="adm-link adm-link--button" onClick={() => setFilter("")}>
              Show all recordings
            </button>
          ) : (
            <SmartLink href="/console/admin/recordings/upload" className="adm-link">
              Upload a recording
            </SmartLink>
          )
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="adm-recordings" aria-label="Recordings">
          {rows.map((row) => (
            <RecordingRow key={row.id} item={row} active={row.id === openId} onOpen={setOpenId} />
          ))}
        </ul>
        {list.data.count > rows.length ? <p className="adm-quiet">Showing the newest {rows.length} of {plural(list.data.count, "recording")}.</p> : null}
      </>
    );
  }

  return (
    <div className="adm-page adm-page--list">
      <PageHeader
        title="Recordings"
        description="Review, publish and fix class recordings in one place."
        eyebrow={null}
        secondaryAction={{ label: "Upload a recording", href: "/console/admin/recordings/upload" }}
      />
      <ScrollTabs tabs={tabs} activeKey={filter || "all"} label="Recording filters" />
      {body}
      <SidePanel
        open={Boolean(openId)}
        title={item?.title || (detail.error ? "Recording" : "Loading…")}
        subtitle={item ? [item.source_label, item.subtitle].filter(Boolean).join(" · ") : undefined}
        onClose={() => setOpenId(null)}
        footer={footer}
      >
        <RecordingPanelBody item={item} loading={detail.loading} error={detail.error} />
      </SidePanel>
    </div>
  );
}
