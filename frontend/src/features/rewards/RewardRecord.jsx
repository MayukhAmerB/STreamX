// The student's own reward record in the Console (/profile and
// /profile/public): three tabs, "Rewards" (rank progress, badges, the XP
// history timeline), "Batches" (enrolments and status) and "Certificates"
// (own certificates, view / download; owner only). Each badge and valid
// certificate has a "Highlight" toggle (at most 3 in total, PATCH
// /engagement/me/highlights/); highlighted items show on the public profile
// under the student's handle. Greys and white only (no gold).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "../../kit/Button";
import { Progress, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../kit/Layout";
import { cn } from "../../kit/lib/cn";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../kit/Tabs";
import { LEVELS, levelProgress, nextLevelFor } from "../engagement-ui/engagementModel";
import RankEmblem from "../landing-rewards/RankEmblem";
import { TIER_LABELS } from "./rewardsContent";
import {
  certificatePageUrl,
  certificatePdfUrl,
  fetchRewardHistory,
  highlightError,
  MAX_HIGHLIGHTS,
  saveHighlights,
  toggleHighlight,
} from "./rewardsApi";

const numberFormat = new Intl.NumberFormat("en-IN");
const fmtXp = (value) => numberFormat.format(Math.max(0, Math.round(Number(value) || 0)));

export function formatRecordDate(value, { withTime = false } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** XP items grouped by `day` (newest first, as the API sends them). */
export function groupXpByDay(items = []) {
  const groups = [];
  for (const item of items) {
    const day = item.day || String(item.date || "").slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) {
      last.items.push(item);
      last.total += Number(item.amount) || 0;
    } else groups.push({ day, items: [item], total: Number(item.amount) || 0 });
  }
  return groups;
}

const BATCH_STATUS = {
  active: "Active",
  expired: "Expired",
  pending: "Pending",
  failed: "Not completed",
};

/** Loads GET /engagement/me/history/ and owns the highlight toggles. */
export function useRewardHistory({ pageSize = 25 } = {}) {
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [xpItems, setXpItems] = useState([]);
  const [xpPage, setXpPage] = useState({ page: 1, has_more: false, total: 0, loadingMore: false });
  const [highlights, setHighlights] = useState({ badges: [], certificates: [], max: MAX_HIGHLIGHTS });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    fetchRewardHistory({ page: 1, pageSize })
      .then((data) => {
        if (!alive.current) return;
        setState({ status: "ready", data: data || {}, error: "" });
        setXpItems(data?.xp?.items || []);
        setXpPage({ page: data?.xp?.page || 1, has_more: Boolean(data?.xp?.has_more), total: data?.xp?.total || 0, loadingMore: false });
        setHighlights({
          badges: data?.highlights?.badges || [],
          certificates: data?.highlights?.certificates || [],
          max: data?.highlights?.max || MAX_HIGHLIGHTS,
        });
      })
      .catch(() => {
        if (alive.current) setState({ status: "error", data: null, error: "Your reward history could not load. Try again later." });
      });
    return () => {
      alive.current = false;
    };
  }, [pageSize]);

  const loadMore = useCallback(() => {
    if (xpPage.loadingMore || !xpPage.has_more) return;
    const next = xpPage.page + 1;
    setXpPage((current) => ({ ...current, loadingMore: true }));
    fetchRewardHistory({ page: next, pageSize })
      .then((data) => {
        if (!alive.current) return;
        setXpItems((items) => [...items, ...(data?.xp?.items || [])]);
        setXpPage({ page: data?.xp?.page || next, has_more: Boolean(data?.xp?.has_more), total: data?.xp?.total || 0, loadingMore: false });
      })
      .catch(() => {
        if (!alive.current) return;
        setXpPage((current) => ({ ...current, loadingMore: false }));
        setNotice("More history could not load. Try again.");
      });
  }, [pageSize, xpPage]);

  const toggle = useCallback(
    (kind, id) => {
      if (saving) return;
      const result = toggleHighlight(highlights, kind, id);
      if (result.error) {
        setNotice(result.error);
        return;
      }
      const previous = highlights;
      setHighlights({ ...result.next, max: highlights.max });
      setSaving(true);
      setNotice("");
      saveHighlights({ badges: result.next.badges, certificates: result.next.certificates })
        .then((saved) => {
          if (!alive.current) return;
          if (saved) setHighlights({ badges: saved.badges || [], certificates: saved.certificates || [], max: saved.max || previous.max });
          setNotice("Highlights saved. They show on your public profile.");
        })
        .catch((error) => {
          if (!alive.current) return;
          setHighlights(previous);
          setNotice(highlightError(error));
        })
        .finally(() => {
          if (alive.current) setSaving(false);
        });
    },
    [highlights, saving]
  );

  return { state, xpItems, xpPage, loadMore, highlights, toggle, saving, notice };
}

function HighlightToggle({ on, disabled, onToggle, label }) {
  return (
    <Button
      type="button"
      variant={on ? "primary" : "secondary"}
      size="xs"
      aria-pressed={on}
      aria-label={`${on ? "Remove highlight from" : "Highlight"} ${label}`}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onToggle()}
    >
      {on ? "Highlighted" : "Highlight"}
    </Button>
  );
}

function Empty({ children }) {
  return <p className="rounded-lg border border-dashed border-white/15 px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}

function SectionTitle({ children, aside }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 border-b border-white/10 pb-2">
      {/* The Console resets heading type (carbon-app.scss), so the size sits on a wrapper the heading inherits. */}
      <div className="text-[0.9375rem] font-semibold leading-6 text-white">
        <h3>{children}</h3>
      </div>
      {aside ? <p className="text-xs text-subtle">{aside}</p> : null}
    </div>
  );
}

function HighlightCount({ highlights }) {
  const used = (highlights.badges?.length || 0) + (highlights.certificates?.length || 0);
  return (
    <span>
      {used} of {highlights.max || MAX_HIGHLIGHTS} highlighted
    </span>
  );
}

export function RankProgress({ summary }) {
  const xp = Number(summary?.total_xp) || 0;
  const level = useMemo(() => {
    const byNumber = LEVELS.find((item) => item.number === Number(summary?.level));
    return byNumber || [...LEVELS].reverse().find((item) => xp >= item.min_xp) || LEVELS[0];
  }, [summary?.level, xp]);
  const next = nextLevelFor(xp);
  const progress = levelProgress(xp, level, next);
  return (
    <div className="rounded-lg border border-white/10 bg-white/[.02] p-4">
      <div className="flex flex-wrap items-center gap-3">
        <RankEmblem number={level.number} title={level.title} size={56} decorative />
        <span className="text-base font-semibold text-white">{level.title}</span>
        <span className="ml-auto text-sm text-[#d4d4d4]">{fmtXp(xp)} XP</span>
      </div>
      <Progress className="mt-3" tone="white" value={progress.percent} label={next ? `${progress.percent}% of the way to ${next.title}` : "Top rank reached"} />
      <p className="mt-2 text-xs text-muted-foreground">
        {next ? `${fmtXp(progress.remaining)} XP to ${next.title}` : "You hold the top rank."}
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        {[
          { label: "Badges", value: fmtXp(summary?.badges_count) },
          { label: "Streak", value: `${fmtXp(summary?.current_streak)} d` },
          { label: "Best streak", value: `${fmtXp(summary?.best_streak)} d` },
        ].map((item) => (
          <div key={item.label} className="rounded-md border border-white/10 px-2 py-2">
            <dt className="text-[0.6875rem] uppercase tracking-[0.12em] text-subtle">{item.label}</dt>
            <dd className="mt-1 text-sm font-semibold text-white">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function RewardsPanel({ record }) {
  const { state, xpItems, xpPage, loadMore, highlights, toggle, saving } = record;
  const data = state.data || {};
  const badges = data.badges || [];
  const groups = groupXpByDay(xpItems);
  return (
    <div className="space-y-6">
      <RankProgress summary={data.summary} />

      <section aria-label="Badges" className="space-y-3">
        <SectionTitle aside={<HighlightCount highlights={highlights} />}>Badges</SectionTitle>
        {badges.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {badges.map((badge) => {
              const on = highlights.badges.includes(badge.key);
              return (
                <li key={badge.key} className={cn("flex items-start gap-3 rounded-lg border p-3", on ? "border-white/40 bg-white/[.04]" : "border-white/10")}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-white">{badge.title}</p>
                    <p className="mt-0.5 text-xs text-subtle">
                      {TIER_LABELS[badge.tier] || badge.tier} badge{badge.earned_at ? ` · ${formatRecordDate(badge.earned_at)}` : ""}
                    </p>
                    {badge.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{badge.description}</p> : null}
                  </div>
                  <HighlightToggle on={on} disabled={saving} label={badge.title} onToggle={() => toggle("badge", badge.key)} />
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>No badges yet. They are earned for streaks, reports, exams and live classes.</Empty>
        )}
      </section>

      <section aria-label="XP history" className="space-y-3">
        <SectionTitle aside={xpPage.total ? `${fmtXp(xpPage.total)} entries` : null}>XP history</SectionTitle>
        {groups.length ? (
          <ol className="space-y-4">
            {groups.map((group) => (
              <li key={group.day}>
                <div className="flex items-center justify-between text-xs text-subtle">
                  <span>{formatRecordDate(group.day)}</span>
                  <span>+{fmtXp(group.total)} XP</span>
                </div>
                <ul className="mt-1.5 border-l border-white/15 pl-3">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex items-baseline justify-between gap-3 py-1 text-sm">
                      <span className="min-w-0 text-[#d4d4d4]">{item.description || item.source_label}</span>
                      <span className={cn("shrink-0 font-medium", Number(item.amount) < 0 ? "text-muted-foreground" : "text-white")}>
                        {Number(item.amount) > 0 ? "+" : ""}
                        {numberFormat.format(Number(item.amount) || 0)} XP
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>No XP yet. Attend a live class or finish a lecture to earn your first.</Empty>
        )}
        {xpPage.has_more ? (
          <Button type="button" variant="secondary" size="xs" aria-disabled={xpPage.loadingMore || undefined} onClick={loadMore}>
            {xpPage.loadingMore ? "Loading…" : "Show older"}
          </Button>
        ) : null}
      </section>
    </div>
  );
}

export function BatchesPanel({ record }) {
  const batches = record.state.data?.batches || [];
  if (!batches.length) return <Empty>No enrolments yet.</Empty>;
  return (
    <Table minWidth={560}>
      <TableHeader>
        <TableRow>
          <TableHead className="px-3 py-2.5">Course</TableHead>
          <TableHead className="px-3 py-2.5">Batch</TableHead>
          <TableHead className="px-3 py-2.5">Status</TableHead>
          <TableHead className="px-3 py-2.5">Started</TableHead>
          <TableHead className="px-3 py-2.5">Access until</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {batches.map((batch) => (
          <TableRow key={batch.enrollment_id}>
            <TableCell className="px-3 py-2.5 text-white">{batch.course_title}</TableCell>
            <TableCell className="px-3 py-2.5">{batch.batch || "—"}</TableCell>
            <TableCell className="px-3 py-2.5">
              <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs", batch.status === "active" ? "border-white/40 text-white" : "border-white/15 text-muted-foreground")}>
                {BATCH_STATUS[batch.status] || batch.status}
              </span>
            </TableCell>
            <TableCell className="px-3 py-2.5">{formatRecordDate(batch.start_date || batch.enrolled_at) || "—"}</TableCell>
            <TableCell className="px-3 py-2.5">
              {batch.access_expires_at ? formatRecordDate(batch.access_expires_at) : batch.access_type === "lifetime" ? "Lifetime" : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CertificatesPanel({ record }) {
  const { state, highlights, toggle, saving } = record;
  const certificates = state.data?.certificates || [];
  return (
    <div className="space-y-3">
      <SectionTitle aside={<HighlightCount highlights={highlights} />}>Your certificates</SectionTitle>
      <p className="text-xs text-subtle">Private to you. Anyone else who opens a certificate link sees only that it is valid, never your name.</p>
      {certificates.length ? (
        <ul className="space-y-2">
          {certificates.map((certificate) => {
            const on = highlights.certificates.includes(certificate.reference);
            return (
              <li key={certificate.reference} className={cn("flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center", on ? "border-white/40 bg-white/[.04]" : "border-white/10")}>
                <div className="min-w-0 sm:flex-1">
                  <p className="text-sm font-medium text-white">{certificate.title || certificate.type_label}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    <span className="break-all font-mono">{certificate.reference}</span>
                    {certificate.issued_on || certificate.issued_at ? ` · Issued ${formatRecordDate(certificate.issued_on || certificate.issued_at)}` : ""}
                    {certificate.valid === false ? " · Revoked" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="secondary" size="xs">
                    <Link to={certificatePageUrl(certificate)}>View</Link>
                  </Button>
                  {certificate.valid !== false ? (
                    <Button asChild variant="secondary" size="xs">
                      <a href={certificatePdfUrl(certificate.reference)} download={`${certificate.reference}.pdf`}>
                        Download PDF
                      </a>
                    </Button>
                  ) : null}
                  {certificate.valid !== false ? (
                    <HighlightToggle
                      on={on}
                      disabled={saving}
                      label={certificate.title || certificate.reference}
                      onToggle={() => toggle("certificate", certificate.reference)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty>No certificates yet. Pass your course exam to earn one.</Empty>
      )}
    </div>
  );
}

export const RECORD_TABS = [
  { value: "rewards", label: "Rewards", Panel: RewardsPanel },
  { value: "batches", label: "Batches", Panel: BatchesPanel },
  { value: "certificates", label: "Certificates", Panel: CertificatesPanel },
];

function RecordStatus({ record }) {
  if (record.state.status === "loading") return <p className="text-sm text-subtle" aria-live="polite">Loading your record…</p>;
  if (record.state.status === "error") return <p className="text-sm text-muted-foreground" role="alert">{record.state.error}</p>;
  return null;
}

/** The three tab triggers + contents for a parent kit <Tabs> (the /profile/public editor). */
export function RewardRecordTabContents({ record }) {
  return RECORD_TABS.map(({ value, Panel }) => (
    <TabsContent key={value} value={value} className="mt-6 space-y-4">
      <RecordStatus record={record} />
      {record.state.status === "ready" ? <Panel record={record} /> : null}
      <p aria-live="polite" className="min-h-5 text-xs text-muted-foreground">{record.notice}</p>
    </TabsContent>
  ));
}

export function RewardRecordTabTriggers() {
  return RECORD_TABS.map(({ value, label }) => (
    <TabsTrigger key={value} value={value}>
      {label}
    </TabsTrigger>
  ));
}

/** Stand-alone section with its own tab bar (the Console /profile page). */
export default function RewardRecord({ className }) {
  const record = useRewardHistory();
  const [tab, setTab] = useState("rewards");
  return (
    <section aria-labelledby="reward-record-title" className={cn("reward-record rounded-lg border border-white/10 bg-[#0a0a0a] p-4 sm:p-5", className)}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-base font-semibold leading-6 text-white">
            <h2 id="reward-record-title">Your record</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">XP, badges, batches and certificates. Highlight up to {MAX_HIGHLIGHTS} for your public profile.</p>
        </div>
        <Link to="/rewards" className="text-xs text-[#d4d4d4] underline underline-offset-4 hover:text-white">
          How rewards work
        </Link>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList aria-label="Your record">
          <RewardRecordTabTriggers />
        </TabsList>
        <RewardRecordTabContents record={record} />
      </Tabs>
    </section>
  );
}
