// Console › Leaderboard (/leaderboard): the viewer's batch, this week or all
// time. OWNER: WS-LEARN (console-student).
//
// Privacy (owner rule, handle only): every row shows the learner's profile
// handle, never a real name; hidden learners are left out. The viewer can change their own display
// here. Fetched on open, then at most every 60 s while visible, with ETag.
import "./Engagement.scss";

import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { apiData, apiMessage } from "../../utils/api";
import { EngagementOff } from "./AchievementsPage";
import { fetchEngagementSettings, fetchLeaderboard, saveEngagementSettings } from "./engagementApi";
import { DISPLAY_CHOICES, batchLabel, formatWeekStart, formatXp, normalizeDisplay } from "./engagementModel";
import { PageIntro } from "./EngagementParts";
import { TabBar } from "./Tabs";
import useEngagement from "./useEngagement";
import useEngagementResource from "./useEngagementResource";
import { publicName } from "../profiles/publicName";

const PERIODS = [
  { key: "week", label: "This week" },
  { key: "all", label: "All time" },
];

export const LEADERBOARD_POLL_MS = 60_000;

function DisplaySetting({ current, onSaved }) {
  const id = useId();
  // Owner rule: handle only. The two choices are fixed: handle or hidden.
  const choices = ["handle", "hidden"];
  const [value, setValue] = useState(normalizeDisplay(current));
  const [state, setState] = useState({ saving: false, message: "", error: "" });

  useEffect(() => {
    setValue(normalizeDisplay(current));
  }, [current]);

  useEffect(() => {
    let active = true;
    fetchEngagementSettings()
      .then((response) => {
        const data = apiData(response, null);
        if (!active || !data) return;
        if (data.leaderboard_display) setValue(normalizeDisplay(data.leaderboard_display));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const save = async (next) => {
    const previous = value;
    setValue(next);
    setState({ saving: true, message: "", error: "" });
    try {
      await saveEngagementSettings({ leaderboard_display: next });
      setState({ saving: false, message: `Saved: ${DISPLAY_CHOICES[next].label.toLowerCase()}.`, error: "" });
      onSaved?.();
    } catch (error) {
      setValue(previous);
      setState({ saving: false, message: "", error: apiMessage(error, "Could not save. Try again.") });
    }
  };

  return (
    <fieldset className="eg-display" aria-describedby={`${id}-hint`}>
      <legend className="eg-kicker">How you appear</legend>
      <div className="eg-segmented" role="radiogroup" aria-label="How you appear on the leaderboard">
        {choices.map((choice) => (
          <label key={choice} className={`eg-segmented__option${value === choice ? " is-active" : ""}`}>
            <input
              type="radio"
              name={`${id}-display`}
              value={choice}
              checked={value === choice}
              disabled={state.saving}
              onChange={() => save(choice)}
            />
            <span>{DISPLAY_CHOICES[choice]?.label || choice}</span>
          </label>
        ))}
      </div>
      <p id={`${id}-hint`} className="eg-display__hint">
        {DISPLAY_CHOICES[value]?.hint}
      </p>
      <p className="eg-display__status" aria-live="polite">
        {state.error ? <span className="eg-display__error">{state.error}</span> : state.message}
      </p>
    </fieldset>
  );
}

export function Board({ data, period }) {
  const entries = data.entries || [];
  const me = data.me;
  const meListed = entries.some((entry) => entry.is_me);
  if (!entries.length) {
    return (
      <p className="eg-empty-line">
        {period === "week" ? "No one in this batch has earned XP this week yet. Finish a lesson to open the board." : "No XP in this batch yet."}
      </p>
    );
  }
  return (
    <div className="eg-board-wrap">
      <table className="eg-board">
        <caption className="cds--visually-hidden">
          {batchLabel(data.batch)} leaderboard, {period === "week" ? "this week" : "all time"}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="eg-board__rank">
              Rank
            </th>
            <th scope="col">Learner</th>
            <th scope="col" className="eg-board__level">
              Level
            </th>
            <th scope="col" className="eg-board__xp">
              XP
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={`${entry.rank}-${publicName(entry)}`} className={entry.is_me ? "is-me" : undefined} aria-current={entry.is_me ? "true" : undefined}>
              <td className="eg-board__rank eg-mono">{String(entry.rank).padStart(2, "0")}</td>
              <th scope="row" className="eg-board__name">
                <span>{publicName(entry)}</span>
                {entry.is_me ? <span className="eg-pill eg-pill--accent">You</span> : null}
              </th>
              <td className="eg-board__level">{entry.level?.title}</td>
              <td className="eg-board__xp eg-mono">{formatXp(entry.xp)}</td>
            </tr>
          ))}
          {me && !meListed && me.rank ? (
            <tr className="is-me is-detached" aria-current="true">
              <td className="eg-board__rank eg-mono">{String(me.rank).padStart(2, "0")}</td>
              <th scope="row" className="eg-board__name">
                <span>{me.visible ? publicName(me, "You") : "You (hidden from others)"}</span>
                <span className="eg-pill eg-pill--accent">You</span>
              </th>
              <td className="eg-board__level" />
              <td className="eg-board__xp eg-mono">{formatXp(me.xp)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export default function LeaderboardPage() {
  const engagement = useEngagement();
  const [period, setPeriod] = useState("week");
  const [batch, setBatch] = useState(null);
  const live = engagement.status !== "off" && engagement.status !== "disabled";
  const board = useEngagementResource((options) => fetchLeaderboard({ ...options, period, batch }), {
    enabled: live,
    pollMs: LEADERBOARD_POLL_MS,
    key: `${period}:${batch || ""}`,
  });
  const data = board.data;

  if (engagement.status === "off" || engagement.status === "disabled" || board.status === "disabled") {
    return (
      <div className="eg-page" data-template="t8">
        <PageIntro eyebrow="Your batch" title="Leaderboard" />
        <EngagementOff title="The leaderboard is switched off for now" />
      </div>
    );
  }

  const batches = data?.batches || [];
  const me = data?.me;
  return (
    <div className="eg-page" data-template="t8">
      <PageIntro
        eyebrow="Your batch"
        title="Leaderboard"
        sub="XP earned by your batch. The weekly board starts again every Monday (India time). Only learners in your batch see it."
      />
      <div className="eg-board-head">
        <TabBar tabs={PERIODS} value={period} onChange={setPeriod} label="Leaderboard period" idPrefix="eg-lb" />
        {batches.length > 1 ? (
          <label className="eg-select">
            <span className="eg-kicker">Batch</span>
            <select value={batch || data?.batch?.id || ""} onChange={(event) => setBatch(Number(event.target.value) || null)}>
              {batches.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {batchLabel(entry)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {PERIODS.filter((entry) => entry.key !== period).map((entry) => (
        <div key={entry.key} role="tabpanel" id={`eg-lb-panel-${entry.key}`} aria-labelledby={`eg-lb-tab-${entry.key}`} hidden />
      ))}
      <div role="tabpanel" id={`eg-lb-panel-${period}`} aria-labelledby={`eg-lb-tab-${period}`} className="eg-tabpanel">
        {board.status === "loading" && !data ? <p className="eg-loading">Loading the board…</p> : null}
        {board.status === "error" && !data ? (
          <div className="eg-notice" role="alert">
            <p className="eg-notice__title">Could not load the leaderboard</p>
            <p className="eg-notice__body">{board.error}</p>
            <button type="button" className="eg-button eg-button--secondary" onClick={board.reload}>
              Try again
            </button>
          </div>
        ) : null}
        {data && !data.batch ? (
          <div className="eg-notice">
            <p className="eg-notice__title">Join a batch to see a leaderboard</p>
            <p className="eg-notice__body">Boards are per batch: you compare with the people you study with, never with everyone.</p>
            <Link className="eg-button eg-button--primary" to="/courses">
              Browse courses
            </Link>
          </div>
        ) : null}
        {data?.batch ? (
          <>
            <section className="eg-board-me" aria-label="Your position">
              <div>
                <p className="eg-kicker">{batchLabel(data.batch)}</p>
                <p className="eg-board-me__rank">
                  {me?.rank ? (
                    <>
                      <span className="eg-mono">#{me.rank}</span>
                      <span className="eg-board-me__of"> of {data.participants}</span>
                    </>
                  ) : (
                    "Not ranked yet"
                  )}
                </p>
                <p className="eg-board-me__meta">
                  <span className="eg-mono">{formatXp(me?.xp)} XP</span>
                  {period === "week" && data.week_start ? <> · week of {formatWeekStart(data.week_start)}</> : null}
                </p>
              </div>
              <DisplaySetting current={me?.leaderboard_display} onSaved={board.reload} />
            </section>
            <Board data={data} period={period} />
          </>
        ) : null}
      </div>
    </div>
  );
}
