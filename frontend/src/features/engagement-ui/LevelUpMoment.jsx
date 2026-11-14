// The level-up moment (owner rules B): when /engagement/me/ says a new rank has
// not been celebrated yet (`level_up.pending`), a small celebratory panel shows
// once; closing it (or opening the level chart) acknowledges it on the server
// (POST /engagement/me/level-seen/). OWNER: WS-LEARN. Mounted by the
// EngagementToaster (Console shell). Motion only without reduced motion.
import "./LevelUp.scss";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDialogTurn } from "../app-shell/dialogQueue";
import { acknowledgeLevelUp } from "./engagementApi";
import { formatXp, levelUpPending } from "./engagementModel";
import useEngagement from "./useEngagement";

const SEEN_KEY = "eg:level-seen";

function locallySeen(levelKey) {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === levelKey;
  } catch {
    return false;
  }
}

function rememberSeen(levelKey) {
  try {
    window.sessionStorage.setItem(SEEN_KEY, levelKey);
  } catch {
    // storage blocked: the server acknowledgement is what counts
  }
}

/** Pure view (tests render it directly). */
export function LevelUpPanel({ level, xp, onClose }) {
  return (
    <section className="eg-levelup" role="dialog" aria-modal="false" aria-labelledby="eg-levelup-title">
      <p className="eg-levelup__eyebrow">New rank</p>
      <h2 className="eg-levelup__title" id="eg-levelup-title">
        You reached <span className="hp-hand">{level?.title}</span>
      </h2>
      <p className="eg-levelup__body">
        Level {level?.number} · {formatXp(xp)} XP. Your rank title now shows on your profile and batch leaderboards.
      </p>
      <div className="eg-levelup__actions">
        <Link className="eg-button eg-button--primary" to="/levels" onClick={onClose}>
          See the level chart
        </Link>
        <button type="button" className="eg-button eg-button--ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

export default function LevelUpMoment() {
  const { enabled, data, refresh } = useEngagement();
  const [closedKey, setClosedKey] = useState("");
  const levelKey = data?.level?.key || "";
  // Waits while the journey welcome or the handle prompt holds the screen.
  const myTurn = useDialogTurn("levelup");
  const show = myTurn && enabled && levelUpPending(data) && closedKey !== levelKey && !locallySeen(levelKey);

  const close = useCallback(() => {
    setClosedKey(levelKey);
    rememberSeen(levelKey);
    acknowledgeLevelUp()
      .then(() => refresh?.({ force: true }))
      .catch(() => {});
  }, [levelKey, refresh]);

  useEffect(() => {
    if (!show) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, close]);

  if (!show) return null;
  return <LevelUpPanel level={data.level} xp={data.xp} onClose={close} />;
}
