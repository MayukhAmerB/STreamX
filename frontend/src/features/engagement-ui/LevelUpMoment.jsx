// The level-up celebration (owner, Nov 2026): every rank promotion gets a
// full-screen moment the next time the student opens the Console (or the
// landing page, signed in): the new rank emblem scales in with a glow and a
// short burst, then "LEVEL UP — <Rank>", the XP total and what the next rank
// needs, with Continue and View achievements. Shown once per promotion: the
// server marker (POST /engagement/me/promotion-seen/) plus a localStorage
// backstop per user and rank (levelUpModel.js). OWNER: WS-LEARN.
//
// Accessibility: a Radix dialog (focus trap, Esc closes, background scroll
// locked, focus restored), labelled by its heading, the XP line as its
// description. Motion: transform/opacity only; under reduced motion it is a
// static card (no burst, no scale, no sheen). No sound (the site has no audio
// setting).
import "./LevelUp.scss";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../../hooks/useAuth";
import { useDialogTurn } from "../app-shell/dialogQueue";
import { HUE } from "../landing-rewards/insigniaPalette";
import LevelBadge from "../landing-rewards/LevelBadge";
import RankEmblem from "../landing-rewards/RankEmblem";
import { acknowledgeLevelUp } from "./engagementApi";
import { celebrationDue, celebrationView, prefersReducedMotion, rememberCelebrated } from "./levelUpModel";
import useEngagement from "./useEngagement";

export const ACHIEVEMENTS_LINK = "/achievements";
const BURST_RAYS = 16;

/** The celebration card (pure: tests render it directly). */
export function LevelUpCard({ view, reducedMotion = false, onContinue, onViewAchievements, titleId = "eg-levelup-title", descriptionId = "eg-levelup-desc" }) {
  if (!view) return null;
  const { rank } = view;
  const energy = rank.number >= 6 ? HUE.emerald : HUE.cyan;
  return (
    <div
      className={`eg-levelup${reducedMotion ? " eg-levelup--static" : ""}`}
      data-rank={rank.number}
      style={{ "--lu-energy": energy }}
    >
      <div className="eg-levelup__stage" aria-hidden="true">
        {reducedMotion ? null : (
          <>
            <span className="eg-levelup__glow" />
            <span className="eg-levelup__ring" />
            <span className="eg-levelup__burst">
              {Array.from({ length: BURST_RAYS }, (_, index) => (
                <span key={index} className="eg-levelup__ray" style={{ "--lu-angle": `${(360 / BURST_RAYS) * index}deg`, "--lu-delay": `${(index % 4) * 40}ms` }} />
              ))}
            </span>
          </>
        )}
        <span className="eg-levelup__emblem">
          <RankEmblem number={rank.number} title={rank.title} size={200} shine={!reducedMotion} animated={!reducedMotion} decorative />
        </span>
        <span className="eg-levelup__lvl">
          <LevelBadge number={rank.number} size={64} animated={!reducedMotion} decorative />
        </span>
      </div>
      <p className="eg-levelup__eyebrow">Rank {rank.roman} · LVL {rank.number}</p>
      <h2 className="eg-levelup__title" id={titleId}>
        <span className="eg-levelup__word">Level up</span> <span aria-hidden="true">—</span>{" "}
        <span className="eg-levelup__rank">{rank.title}</span>
      </h2>
      <p className="eg-levelup__xp" id={descriptionId}>
        <span className="eg-levelup__total">{view.xpText}</span> in total. {view.nextText}
      </p>
      {view.next ? (
        <div className="eg-levelup__meter" role="img" aria-label={`${Math.round(view.progress * 100)}% of the way to ${view.next.title}`}>
          <span className="eg-levelup__meter-fill" style={{ transform: `scaleX(${view.progress})` }} />
        </div>
      ) : null}
      <div className="eg-levelup__actions">
        <button type="button" className="eg-levelup__button eg-levelup__button--primary" onClick={onContinue} data-autofocus>
          Continue
        </button>
        <Link className="eg-levelup__button" to={ACHIEVEMENTS_LINK} onClick={onViewAchievements}>
          View achievements
        </Link>
      </div>
    </div>
  );
}

/** The full-screen dialog around the card. */
export function LevelUpOverlay({ view, onClose, reducedMotion: forceStatic }) {
  const detected = useMemo(() => prefersReducedMotion(), []);
  const reducedMotion = forceStatic ?? detected;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="eg-levelup-backdrop" />
        <DialogPrimitive.Content
          className="eg-levelup-dialog"
          aria-modal="true"
          aria-labelledby="eg-levelup-title"
          aria-describedby="eg-levelup-desc"
          onOpenAutoFocus={(event) => {
            const target = event.currentTarget?.querySelector?.("[data-autofocus]");
            if (target) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
        >
          <DialogPrimitive.Title className="eg-levelup-sr">New rank: {view.rank.title}</DialogPrimitive.Title>
          <LevelUpCard view={view} reducedMotion={reducedMotion} onContinue={onClose} onViewAchievements={onClose} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Shows the celebration once per promotion for the given GET /engagement/me/
 * `data`. `refresh` (optional) reloads it after the acknowledgement.
 */
export function LevelUpGate({ data, enabled = true, refresh = null }) {
  const auth = useAuth() || {};
  const userId = auth.user?.id ?? null;
  const [closedKey, setClosedKey] = useState("");
  const levelKey = data?.level?.key || "";
  // Waits while the journey welcome or the handle prompt holds the screen.
  const myTurn = useDialogTurn("levelup");
  const view = useMemo(() => celebrationView(data), [data]);
  const show = Boolean(myTurn && enabled && view && closedKey !== levelKey && celebrationDue(data, userId));

  const close = useCallback(() => {
    setClosedKey(levelKey);
    rememberCelebrated(userId, levelKey);
    acknowledgeLevelUp()
      .then(() => refresh?.({ force: true }))
      .catch(() => {});
  }, [levelKey, refresh, userId]);

  if (!show) return null;
  return <LevelUpOverlay view={view} onClose={close} />;
}

/** The Console mount (EngagementToaster): the shell's engagement store. */
export default function LevelUpMoment() {
  const { enabled, data, refresh } = useEngagement();
  return <LevelUpGate data={data} enabled={enabled} refresh={refresh} />;
}
