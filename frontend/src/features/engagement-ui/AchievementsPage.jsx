// Console › Achievements (/achievements): badge cabinet, rank ladder and
// verifiable certificates. OWNER: WS-LEARN (console-student).
// Data: /api/engagement/{me,badges,achievements}/ (engagement-notes.md §9).
import "./Engagement.scss";

import { Checkmark, Copy, Download, Launch, Locked } from "@carbon/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fetchBadgeCatalogue, fetchMyAchievements } from "./engagementApi";
import {
  LEVELS,
  describeStreak,
  formatEarnedDate,
  formatXp,
  levelProgress,
  splitBadges,
  tierInfo,
  verifyHref,
} from "./engagementModel";
import { BadgeMedal, PageIntro, ProgressRing, StatStrip } from "./EngagementParts";
import { TabBar, TabPanel } from "./Tabs";
import useEngagement from "./useEngagement";
import useEngagementResource from "./useEngagementResource";

const TABS = [
  { key: "badges", label: "Badges" },
  { key: "ranks", label: "Ranks" },
  { key: "certificates", label: "Certificates" },
];

export function EngagementOff({ title = "Achievements are switched off for now" }) {
  return (
    <div className="eg-off" role="status">
      <p className="eg-off__eyebrow">Coming soon</p>
      <h2 className="eg-off__title">{title}</h2>
      <p className="eg-off__body">
        XP, streaks and badges are not open yet. Your lessons, reports and exams still count as usual, and nothing you do is lost.
      </p>
      <Link className="eg-button eg-button--secondary" to="/console">
        Back to Home
      </Link>
    </div>
  );
}

function LoadError({ message, onRetry }) {
  return (
    <div className="eg-notice" role="alert">
      <p className="eg-notice__title">Could not load this</p>
      <p className="eg-notice__body">{message}</p>
      {onRetry ? (
        <button type="button" className="eg-button eg-button--secondary" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** "Operative → Operator": the current level with its ring. */
export function LevelCard({ summary, data }) {
  const xp = summary?.xp ?? data?.xp ?? 0;
  const level = summary?.level || data?.level;
  const next = data?.next_level || null;
  const progress = levelProgress(xp, level, next);
  return (
    <section className="eg-level" aria-labelledby="eg-level-title">
      <ProgressRing value={progress.percent} size={88} stroke={5} label={next ? `Progress to ${next.title}` : "Top rank reached"}>
        <span className="eg-level__number">{level?.number ?? 1}</span>
      </ProgressRing>
      <div className="eg-level__text">
        <p className="eg-kicker">Rank {level?.number ?? 1} of {LEVELS.length}</p>
        <h2 id="eg-level-title" className="eg-level__title">
          {level?.title || "Recruit"}
        </h2>
        <p className="eg-level__meta">
          {next ? (
            <>
              <span className="eg-mono">{formatXp(progress.remaining)} XP</span> to {next.title}
            </>
          ) : (
            "You reached the top rank."
          )}
        </p>
      </div>
    </section>
  );
}

function BadgeCard({ badge }) {
  const tier = tierInfo(badge.tier);
  const earned = Boolean(badge.earned);
  return (
    <li className={`eg-badge${earned ? " is-earned" : " is-locked"}`}>
      <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned={earned} size={56} />
      <div className="eg-badge__text">
        <h3 className="eg-badge__title">{badge.title}</h3>
        <p className="eg-badge__desc">
          {earned ? null : <span className="cds--visually-hidden">To earn: </span>}
          {badge.description}
        </p>
        <p className="eg-badge__meta">
          {earned ? (
            <>
              <Checkmark size={14} aria-hidden="true" />
              <span>Earned {formatEarnedDate(badge.earned_at)}</span>
            </>
          ) : (
            <>
              <Locked size={14} aria-hidden="true" />
              <span>Locked</span>
            </>
          )}
          {tier.label ? <span className="eg-badge__tier">{tier.label}</span> : null}
        </p>
      </div>
    </li>
  );
}

export function BadgesPanel({ catalogue }) {
  const { earned, locked } = splitBadges(catalogue.data?.badges);
  if (catalogue.status === "loading" && !catalogue.data) return <p className="eg-loading">Loading badges…</p>;
  if (catalogue.status === "error") return <LoadError message={catalogue.error} onRetry={catalogue.reload} />;
  return (
    <>
      <div className="eg-chapter">
        <span className="eg-chapter__label">Earned</span>
        <span className="eg-chapter__rule" aria-hidden="true" />
        <span className="eg-chapter__count">{earned.length}</span>
      </div>
      {earned.length ? (
        <ul className="eg-badges">
          {earned.map((badge) => (
            <BadgeCard key={badge.key} badge={badge} />
          ))}
        </ul>
      ) : (
        <p className="eg-empty-line">Your first badge arrives with your first finished lesson.</p>
      )}
      <div className="eg-chapter">
        <span className="eg-chapter__label">Still to earn</span>
        <span className="eg-chapter__rule" aria-hidden="true" />
        <span className="eg-chapter__count">{locked.length}</span>
      </div>
      <ul className="eg-badges">
        {locked.map((badge) => (
          <BadgeCard key={badge.key} badge={badge} />
        ))}
      </ul>
    </>
  );
}

export function RanksPanel({ xp, levelNumber }) {
  return (
    <ol className="eg-ladder">
      {LEVELS.map((level) => {
        const state = level.number < levelNumber ? "passed" : level.number === levelNumber ? "current" : "ahead";
        return (
          <li key={level.key} className={`eg-ladder__row is-${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="eg-ladder__number eg-mono">{String(level.number).padStart(2, "0")}</span>
            <span className="eg-ladder__title">{level.title}</span>
            <span className="eg-ladder__xp eg-mono">{formatXp(level.min_xp)} XP</span>
            <span className="eg-ladder__state">
              {state === "passed" ? (
                <>
                  <Checkmark size={16} aria-hidden="true" />
                  Reached
                </>
              ) : state === "current" ? (
                <span className="eg-pill eg-pill--accent">You are here</span>
              ) : (
                <span className="eg-ladder__to-go">{formatXp(Math.max(0, level.min_xp - xp))} XP to go</span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CopyLink({ href }) {
  const [copied, setCopied] = useState(false);
  if (!href) return null;
  return (
    <button
      type="button"
      className="eg-button eg-button--ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(href);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Checkmark size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
    </button>
  );
}

const KIND_LABEL = { badge: "Badge", level: "Rank", course: "Course completed" };

export function CertificatesPanel({ achievements }) {
  if (achievements.status === "loading" && !achievements.data) return <p className="eg-loading">Loading certificates…</p>;
  if (achievements.status === "error") return <LoadError message={achievements.error} onRetry={achievements.reload} />;
  const rows = achievements.data?.achievements || [];
  if (!rows.length) {
    return (
      <p className="eg-empty-line">
        Every badge, rank and finished course becomes a certificate here, with a public link anyone can check.
      </p>
    );
  }
  return (
    <ul className="eg-certs">
      {rows.map((row) => (
        <li key={row.slug} className={`eg-cert${row.valid ? "" : " is-revoked"}`}>
          <BadgeMedal badgeKey={row.key} tier={row.tier} earned={row.valid} size={48} />
          <div className="eg-cert__text">
            <p className="eg-kicker">
              {KIND_LABEL[row.kind] || "Achievement"}
              {row.earned_at ? <span className="eg-kicker__soft"> · {formatEarnedDate(row.earned_at)}</span> : null}
            </p>
            <h3 className="eg-cert__title">{row.title}</h3>
            {row.subtitle ? <p className="eg-cert__desc">{row.subtitle}</p> : null}
            {row.valid ? null : <p className="eg-cert__revoked">Revoked: this certificate no longer verifies.</p>}
          </div>
          {row.valid ? (
            <div className="eg-cert__actions">
              <a className="eg-button eg-button--secondary" href={row.certificate_url} download>
                <Download size={16} aria-hidden="true" />
                Certificate <span className="cds--visually-hidden">for {row.title}</span>
                <span className="eg-button__hint">PDF</span>
              </a>
              <a className="eg-button eg-button--ghost" href={row.share_card_url} target="_blank" rel="noopener noreferrer">
                Share card <span className="cds--visually-hidden">for {row.title} (opens in a new tab)</span>
                <Launch size={16} aria-hidden="true" />
              </a>
              <CopyLink href={verifyHref(row)} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function AchievementsPage() {
  const engagement = useEngagement();
  const [tab, setTab] = useState("badges");
  const live = engagement.status !== "off" && engagement.status !== "disabled";
  const catalogue = useEngagementResource(fetchBadgeCatalogue, { enabled: live });
  const achievements = useEngagementResource(fetchMyAchievements, { enabled: live && tab === "certificates", key: "achievements" });
  const data = engagement.data;
  const summary = engagement.summary;
  const streak = describeStreak(summary?.streak || data?.streak);
  const stats = useMemo(() => {
    if (!data) return [];
    return [
      { label: "Rank", value: summary?.level?.title || data.level?.title || "Recruit" },
      { label: "Total XP", value: <span className="eg-mono">{formatXp(summary?.xp ?? data.xp)}</span> },
      { label: "Streak", value: <span className="eg-mono">{streak.count}</span>, hint: streak.count === 1 ? "day" : "days" },
      {
        label: "Badges",
        value: <span className="eg-mono">{data.badges_count ?? 0}</span>,
        hint: `of ${data.badges_available ?? 26}`,
      },
    ];
  }, [data, summary, streak.count]);

  if (engagement.status === "off" || engagement.status === "disabled" || catalogue.status === "disabled") {
    return (
      <div className="eg-page" data-template="t8">
        <PageIntro eyebrow="Your progress" title="Achievements" />
        <EngagementOff />
      </div>
    );
  }

  return (
    <div className="eg-page" data-template="t8">
      <PageIntro
        eyebrow="Your progress"
        title="Achievements"
        sub="Badges, ranks and certificates you earn as you study. Each certificate has a public link anyone can check."
      />
      {engagement.status === "error" && !data ? <LoadError message="Your progress could not be loaded." onRetry={() => engagement.refresh({ force: true })} /> : null}
      {data ? (
        <>
          <StatStrip items={stats} label="Your progress in numbers" className="eg-stats--page" />
          <LevelCard summary={summary} data={data} />
        </>
      ) : engagement.status === "loading" ? (
        <p className="eg-loading">Loading your progress…</p>
      ) : null}
      <TabBar tabs={TABS} value={tab} onChange={setTab} label="Achievements" idPrefix="eg-ach" />
      <TabPanel idPrefix="eg-ach" tabKey="badges" active={tab === "badges"}>
        <BadgesPanel catalogue={catalogue} />
      </TabPanel>
      <TabPanel idPrefix="eg-ach" tabKey="ranks" active={tab === "ranks"}>
        <RanksPanel xp={summary?.xp ?? data?.xp ?? 0} levelNumber={summary?.level?.number ?? data?.level?.number ?? 1} />
      </TabPanel>
      <TabPanel idPrefix="eg-ach" tabKey="certificates" active={tab === "certificates"}>
        <CertificatesPanel achievements={achievements} />
      </TabPanel>
    </div>
  );
}
