// Console › Level chart (/levels): every rank with its XP threshold and what it
// unlocks, how to earn XP, and where the viewer stands. OWNER: WS-LEARN.
// Data: GET /engagement/levels/ (the server's rules are the source of truth).
import "./Engagement.scss";

import { Link } from "react-router-dom";
import { EngagementOff } from "./AchievementsPage";
import { fetchLevelChart } from "./engagementApi";
import { formatXp, levelProgress } from "./engagementModel";
import { PageIntro, ProgressRing } from "./EngagementParts";
import useEngagement from "./useEngagement";
import useEngagementResource from "./useEngagementResource";

/** "You are here" card: rank, XP and the way to the next rank. */
export function LevelPosition({ me }) {
  if (!me) return null;
  const progress = levelProgress(me.xp, me.level, me.next_level);
  return (
    <section className="eg-level" aria-labelledby="eg-levels-me">
      <ProgressRing value={progress.percent} size={88} stroke={5} label={me.next_level ? `Progress to ${me.next_level.title}` : "Top rank reached"}>
        <span className="eg-mono">{me.level?.number ?? 1}</span>
      </ProgressRing>
      <div>
        <p className="eg-kicker" id="eg-levels-me">
          You are a {me.level?.title || "Recruit"}
        </p>
        <p className="eg-level__xp">
          <span className="eg-mono">{formatXp(me.xp)}</span> XP
        </p>
        <p className="eg-level__next">
          {me.next_level
            ? `${formatXp(me.xp_to_next_level)} XP to ${me.next_level.title}`
            : "You hold the highest rank."}
        </p>
      </div>
    </section>
  );
}

/** The ladder with thresholds and unlocks. */
export function LevelLadder({ levels = [] }) {
  return (
    <ol className="eg-ladder" aria-label="Ranks">
      {levels.map((level) => {
        const state = level.current ? "current" : level.reached ? "passed" : "ahead";
        return (
          <li key={level.key} className={`eg-ladder__row is-${state}`} aria-current={level.current ? "step" : undefined}>
            <span className="eg-ladder__number eg-mono">{String(level.number).padStart(2, "0")}</span>
            <span className="eg-ladder__title">
              {level.title}
              {level.unlocks?.length ? (
                <span className="eg-ladder__unlocks">{level.unlocks.join(" · ")}</span>
              ) : null}
            </span>
            <span className="eg-ladder__xp eg-mono">{formatXp(level.min_xp)} XP</span>
            <span className="eg-ladder__state">
              {level.current ? <span className="eg-pill eg-pill--accent">You are here</span> : level.reached ? "Reached" : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** How to earn XP, from the server's live rule values. */
export function EarnTable({ rows = [] }) {
  if (!rows.length) return null;
  return (
    <table className="eg-earn">
      <caption className="eg-chapter__label">How to earn XP</caption>
      <thead>
        <tr>
          <th scope="col">Activity</th>
          <th scope="col">XP</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.key}-${index}`}>
            <th scope="row">
              {row.label}
              {row.example ? <span className="eg-earn__example"> (e.g. {row.example})</span> : null}
            </th>
            <td className="eg-mono">+{formatXp(row.xp)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LevelsPage() {
  const { enabled, status } = useEngagement();
  const chart = useEngagementResource(fetchLevelChart, { enabled });
  if (!enabled || status === "off" || status === "disabled" || chart.status === "disabled") {
    return <EngagementOff title="The level chart is switched off for now" />;
  }
  const data = chart.data;
  return (
    <div className="eg-page" data-page="levels">
      <PageIntro
        eyebrow="Ranks"
        title="The level"
        accent="chart"
        sub={data?.curve?.note || "Eight ranks, from Recruit to Elite Operator."}
      >
        <Link className="eg-button eg-button--ghost" to="/achievements">
          Your achievements
        </Link>
      </PageIntro>
      {chart.status === "loading" && !data ? <p className="eg-loading">Loading the level chart…</p> : null}
      {chart.status === "error" ? (
        <div className="eg-notice" role="alert">
          <p className="eg-notice__title">Could not load this</p>
          <p className="eg-notice__body">{chart.error}</p>
          <button type="button" className="eg-button eg-button--secondary" onClick={() => chart.reload?.()}>
            Try again
          </button>
        </div>
      ) : null}
      {data ? (
        <>
          <LevelPosition me={data.me} />
          <LevelLadder levels={data.levels} />
          <EarnTable rows={data.earn} />
        </>
      ) : null}
    </div>
  );
}
