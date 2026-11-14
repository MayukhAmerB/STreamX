// /console/admin/requests: enrolment + live-class requests (plan §4.3, §4.6).
// OWNER: WS-G. One list for both kinds, oldest first while pending. Each row
// has Approve / Reject inline; selecting rows brings up the bulk bar. A
// decided row fades out (M21), the count updates, and a toast offers Undo
// (which puts the request back to pending). Everything goes through the
// enrolment_actions service on the server (save(), audit, notification).
import { Checkmark, Close, UserFollow } from "@carbon/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiMessage } from "../../utils/api";
import { BulkBar, EmptyState, ErrorState, PageHeader, ScrollTabs, Toolbar, useSkeletonGate, useToast } from "../app-shell/ui";
import { SkeletonBlocks } from "./AdminBits";
import { actOnRequests, fetchRequests } from "./api";
import { ago, dateTime, plural } from "./format";
import SmartLink from "./SmartLink";
import useAdminData from "./useAdminData";
import "./admin.scss";

const STATUS_TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];
const KINDS = [
  { key: "all", label: "All" },
  { key: "course", label: "Course access" },
  { key: "live_class", label: "Live classes" },
];
const DONE_WORD = { approve: "Approved", reject: "Rejected", reopen: "Moved back to pending" };
export const ROW_EXIT_MS = 110;

function prefersReduced() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce";
}

export function RequestRow({ row, selected, onToggle, onAct, busy, leaving, status }) {
  const primary = status === "rejected" ? "approve" : status === "approved" ? "reject" : "approve";
  const secondary = status === "pending" ? "reject" : null;
  const label = { approve: "Approve", reject: status === "approved" ? "Revoke" : "Reject" };
  const who = row.student?.name || row.student?.email;
  return (
    <li className={`adm-request${leaving ? " is-leaving" : ""}${selected ? " is-selected" : ""}`} data-request={row.id}>
      {row.can_change ? (
        <label className="adm-check">
          <input type="checkbox" checked={selected} onChange={() => onToggle(row.id)} aria-label={`Select ${who}`} />
          <span className="adm-check__box" aria-hidden="true" />
        </label>
      ) : (
        <span className="adm-check adm-check--empty" aria-hidden="true" />
      )}
      <div className="adm-request__who">
        <p className="adm-request__name">{who}</p>
        <p className="adm-request__contact">
          <span>{row.student?.email}</span>
          {row.student?.phone ? <span> · {row.student.phone}</span> : null}
        </p>
      </div>
      <div className="adm-request__what">
        <p className="adm-request__target">{row.target?.title}</p>
        <p className="adm-request__kind">{row.kind_label}</p>
      </div>
      <p className="adm-request__when">
        <time dateTime={row.requested_at} title={dateTime(row.requested_at)}>
          {ago(row.requested_at)}
        </time>
      </p>
      <div className="adm-request__actions">
        {row.can_change ? (
          <>
            <button
              type="button"
              className="adm-button adm-button--primary"
              disabled={busy}
              onClick={() => onAct([row.id], primary)}
              aria-label={`${label[primary]} ${who}`}
            >
              {primary === "approve" ? <Checkmark size={16} aria-hidden="true" /> : null}
              {label[primary]}
            </button>
            {secondary ? (
              <button
                type="button"
                className="adm-button adm-button--ghost"
                disabled={busy}
                onClick={() => onAct([row.id], secondary)}
                aria-label={`${label[secondary]} ${who}`}
              >
                <Close size={16} aria-hidden="true" />
                {label[secondary]}
              </button>
            ) : null}
          </>
        ) : (
          <SmartLink href={row.back_office_href} className="adm-link">
            View
          </SmartLink>
        )}
      </div>
    </li>
  );
}

export default function AdminRequestsPage() {
  const [params, setParams] = useSearchParams();
  const status = STATUS_TABS.some((tab) => tab.key === params.get("status")) ? params.get("status") : "pending";
  const kind = KINDS.some((item) => item.key === params.get("kind")) ? params.get("kind") : "all";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [leaving, setLeaving] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const { showToast } = useToast();
  const debounced = useDebounced(query, 250);

  const list = useAdminData(() => fetchRequests({ status, kind, q: debounced }), { deps: [status, kind, debounced] });
  const phase = useSkeletonGate(list.loading && !list.data);
  const rows = useMemo(() => list.data?.results || [], [list.data]);
  const counts = list.data?.counts || {};
  const visibleIds = rows.filter((row) => row.can_change && !leaving.has(row.id)).map((row) => row.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (!value || value === (key === "status" ? "pending" : "all")) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  const toggle = useCallback((id) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const act = useCallback(
    async (ids, action, { isUndo = false } = {}) => {
      if (!ids.length) return;
      setBusy(true);
      setActionError("");
      try {
        const response = await actOnRequests(ids, action);
        const result = response?.data?.data || {};
        const changed = (result.results || []).filter((item) => item.changed).map((item) => item.id);
        if (isUndo) {
          showToast({ kind: "info", title: "Undone", subtitle: "The request is pending again." });
          list.reload({ quiet: true });
          return;
        }
        // M21: decided rows fade (fast-02), then collapse at once; the list then refetches quietly.
        setLeaving((current) => new Set([...current, ...changed]));
        setSelected((current) => new Set([...current].filter((id) => !ids.includes(id))));
        window.setTimeout(
          () => {
            list.setData((data) =>
              data
                ? {
                    ...data,
                    results: data.results.filter((row) => !changed.includes(row.id)),
                    count: Math.max(0, (data.count || 0) - changed.length),
                    counts: {
                      ...data.counts,
                      [status]: Math.max(0, (data.counts?.[status] || 0) - changed.length),
                    },
                  }
                : data
            );
            setLeaving((current) => new Set([...current].filter((id) => !changed.includes(id))));
            list.reload({ quiet: true });
          },
          prefersReduced() ? 0 : ROW_EXIT_MS
        );
        if (changed.length) {
          const one = rows.find((row) => row.id === changed[0]);
          showToast({
            kind: "success",
            title: DONE_WORD[action],
            subtitle:
              changed.length === 1 && one
                ? `${one.student?.name || one.student?.email} · ${one.target?.title}`
                : plural(changed.length, "request"),
            action: action === "reopen" ? null : { label: "Undo", onClick: () => act(changed, "reopen", { isUndo: true }) },
          });
        } else {
          showToast({ kind: "info", title: "Nothing changed", subtitle: "Those requests were already decided." });
          list.reload({ quiet: true });
        }
      } catch (error) {
        setActionError(apiMessage(error, "That did not work. Try again."));
      } finally {
        setBusy(false);
      }
    },
    [list, rows, showToast, status]
  );

  const tabs = STATUS_TABS.map((tab) => ({
    ...tab,
    badge: tab.key === "pending" && counts.pending ? counts.pending : undefined,
    onClick: () => setFilter("status", tab.key),
  }));
  const kindChips = KINDS.filter((item) => item.key === "all" || (list.data?.kinds || []).some((k) => k.key === item.key)).map((item) => ({
    key: item.key,
    label: item.label,
    active: item.key === kind,
    onClick: () => setFilter("kind", item.key),
  }));

  const selectedCount = [...selected].filter((id) => visibleIds.includes(id)).length;
  const selectedIds = [...selected].filter((id) => visibleIds.includes(id));
  const bulkActions =
    status === "pending"
      ? [
          { label: `Approve ${selectedCount}`, onClick: () => act(selectedIds, "approve"), primary: true, disabled: busy, icon: Checkmark },
          { label: `Reject ${selectedCount}`, onClick: () => act(selectedIds, "reject"), disabled: busy },
        ]
      : status === "approved"
        ? [{ label: `Revoke ${selectedCount}`, onClick: () => act(selectedIds, "reject"), disabled: busy }]
        : [{ label: `Approve ${selectedCount}`, onClick: () => act(selectedIds, "approve"), primary: true, disabled: busy }];

  let body;
  if (list.error && !list.data) {
    body = <ErrorState error={list.error} onRetry={() => list.reload()} />;
  } else if (!list.data) {
    body = phase === "skeleton" ? <SkeletonBlocks count={4} className="adm-skeleton-row" label="Loading requests" /> : <div className="adm-skeleton adm-skeleton--waiting" />;
  } else if (!rows.length) {
    body = (
      <EmptyState
        icon={UserFollow}
        title={
          debounced
            ? `No ${status} requests match “${debounced}”.`
            : status === "pending"
              ? "No requests are waiting."
              : `No ${status} requests yet.`
        }
        body={status === "pending" && !debounced ? "New requests appear here as soon as students ask for access." : undefined}
        action={
          status === "pending" ? (
            <button type="button" className="adm-link adm-link--button" onClick={() => setFilter("status", "approved")}>
              See approved requests
            </button>
          ) : (
            <button type="button" className="adm-link adm-link--button" onClick={() => setFilter("status", "pending")}>
              Back to pending
            </button>
          )
        }
      />
    );
  } else {
    body = (
      <>
        <div className="adm-request-head">
          {visibleIds.length ? (
            <label className="adm-check">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                aria-label={allSelected ? "Clear selection" : "Select all on this page"}
              />
              <span className="adm-check__box" aria-hidden="true" />
            </label>
          ) : (
            <span className="adm-check adm-check--empty" aria-hidden="true" />
          )}
          <span className="adm-request-head__label">Student</span>
          <span className="adm-request-head__label adm-request-head__label--what">Wants</span>
          <span className="adm-request-head__label adm-request-head__label--when">Asked</span>
        </div>
        <ul className="adm-requests" aria-label={`${status} requests`}>
          {rows.map((row) => (
            <RequestRow
              key={row.id}
              row={row}
              status={status}
              selected={selected.has(row.id)}
              onToggle={toggle}
              onAct={act}
              busy={busy}
              leaving={leaving.has(row.id)}
            />
          ))}
        </ul>
        {list.data.count > rows.length ? (
          <p className="adm-quiet">
            Showing {rows.length} of {list.data.count}. Decide these first; the next ones load after.
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="adm-page adm-page--list">
      <PageHeader title="Requests" description="Approve or reject access to courses and live classes." eyebrow={null} />
      <ScrollTabs tabs={tabs} activeKey={status} label="Request status" />
      <Toolbar
        search={{ value: query, onChange: setQuery, placeholder: "Search by student or course", label: "Search requests" }}
        chips={kindChips.length > 1 ? kindChips : []}
        count={list.data ? list.data.count : undefined}
        countLabel={list.data ? plural(list.data.count, "request") : undefined}
      />
      {actionError ? <ErrorState error={actionError} title="The change was not saved." /> : null}
      {body}
      <BulkBar count={selectedCount} actions={bulkActions} onClear={() => setSelected(new Set())} />
    </div>
  );
}

function useDebounced(value, ms) {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    if (value === current) return undefined;
    if (!value) {
      setCurrent("");
      return undefined;
    }
    const timer = window.setTimeout(() => setCurrent(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, current, ms]);
  return current;
}
