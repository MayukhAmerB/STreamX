// "Your journey so far": a one-time welcome for students who studied here
// before release day (owner rule 6). GET /engagement/journey/ says whether to
// show it ({ show, journey }); "Continue", Escape or the close button dismiss
// it for good (POST /engagement/journey/dismiss/). Renders nothing for staff,
// instructors, newcomers, when engagement is switched off (403) or on any
// error. It goes first among the shell's once-only dialogs (dialogQueue): the
// handle prompt and the level-up moment wait until it is answered.
// OWNER: WS-LEARN. Radix Dialog: focus trap, Escape, focus restore.
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import { Button } from "../../kit/Button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../kit/Dialog";
import { holdDialog, releaseDialog } from "../app-shell/dialogQueue";
import { BadgeMedal } from "./EngagementParts";
import { dismissJourney, fetchJourney } from "./engagementApi";
import { formatEarnedDate, formatXp, isLegacyBadge, journeyShareUrl, normalizeJourney } from "./engagementModel";

// Students whose journey was answered (or had none) in this page load.
const settledUsers = new Set();

/** Test helper. */
export function resetJourneyWelcome() {
  settledUsers.clear();
}

/** Share the journey: the native share sheet when there is one, else copy the link. */
export async function shareJourney(journey, nav = typeof navigator !== "undefined" ? navigator : null) {
  const url = journeyShareUrl(journey);
  if (!url) return "none";
  const title = "My journey so far";
  const text = journey.level?.title ? `${journey.level.title} · ${formatXp(journey.xp)} XP` : `${formatXp(journey.xp)} XP`;
  if (nav && typeof nav.share === "function") {
    try {
      await nav.share({ title, text, url });
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
      // fall through to copying
    }
  }
  if (nav?.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(url);
      return "copied";
    } catch {
      return "failed";
    }
  }
  return "failed";
}

const SHARE_MESSAGES = { copied: "Link copied.", failed: "Could not share. Copy the link from your profile.", none: "" };

/** The dialog body (tests render it directly). */
export function JourneyPanel({ journey, shareStatus = "", onShare, canShare = true }) {
  const legacy = journey.badges.filter(isLegacyBadge);
  const others = journey.badges.filter((badge) => !isLegacyBadge(badge));
  return (
    <div className="eg-journey" data-testid="journey-panel">
      <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-3">
        <div className="bg-background p-4">
          <dt className="text-eyebrow uppercase text-subtle">Rank</dt>
          <dd className="mt-1 text-lg font-medium text-white">{journey.level?.title || "Recruit"}</dd>
        </div>
        <div className="bg-background p-4">
          <dt className="text-eyebrow uppercase text-subtle">XP</dt>
          <dd className="mt-1 font-mono text-lg tabular-nums text-white">{formatXp(journey.xp)}</dd>
        </div>
        {journey.rank ? (
          <div className="bg-background p-4">
            <dt className="text-eyebrow uppercase text-subtle">All-time in your batch</dt>
            <dd className="mt-1 font-mono text-lg tabular-nums text-white">#{journey.rank}</dd>
          </div>
        ) : journey.bestStreak ? (
          <div className="bg-background p-4">
            <dt className="text-eyebrow uppercase text-subtle">Best streak</dt>
            <dd className="mt-1 font-mono text-lg tabular-nums text-white">{journey.bestStreak} days</dd>
          </div>
        ) : null}
      </dl>

      {legacy.length || others.length ? (
        <section className="mt-6" aria-labelledby="eg-journey-badges">
          <h3 id="eg-journey-badges" className="text-sm font-medium text-white">
            Your badges
          </h3>
          <ul className="mt-3 grid gap-2">
            {[...legacy, ...others].slice(0, 8).map((badge) => (
              <li key={badge.key} className="flex items-center gap-3" data-legacy={isLegacyBadge(badge) ? "true" : undefined}>
                <BadgeMedal badgeKey={badge.key} tier={badge.tier} earned size={36} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-white">{badge.title}</span>
                  {badge.description ? <span className="block text-xs leading-5 text-muted-foreground">{badge.description}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {journey.glow ? (
        <p className="mt-6 rounded-lg border border-[rgba(255,240,205,0.35)] px-4 py-3 text-sm leading-6 text-white/90">
          <strong className="font-medium text-[#fff4d6]">Founding Glow</strong> is on your profile for 30 days
          {journey.glow.endsAt ? ` (until ${formatEarnedDate(journey.glow.endsAt)})` : ""}: a thank-you for still studying with us at launch.
        </p>
      ) : null}

      {journey.certificates.length ? (
        <section className="mt-6" aria-labelledby="eg-journey-certificates">
          <h3 id="eg-journey-certificates" className="text-sm font-medium text-white">
            Your certificates
          </h3>
          <ul className="mt-2 grid gap-1.5">
            {journey.certificates.map((certificate) => (
              <li key={certificate.reference}>
                <a className="text-sm text-white underline underline-offset-4 hover:no-underline" href={certificate.url} target="_blank" rel="noopener noreferrer">
                  {certificate.title || certificate.heading} <span className="font-mono text-xs text-subtle">{certificate.reference}</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canShare && journeyShareUrl(journey) ? (
        <p className="mt-6 flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={onShare}>
            Share
          </Button>
          <span role="status" className="text-xs text-subtle">
            {SHARE_MESSAGES[shareStatus] || ""}
          </span>
        </p>
      ) : null}
    </div>
  );
}

export default function JourneyWelcome() {
  const { user } = useAuth();
  const isStudent = Boolean(user?.id) && !user?.is_admin && user?.role !== "instructor";
  const userId = user?.id;
  const holding = useRef(false);
  const dismissed = useRef(false);
  const [journey, setJourney] = useState(null);
  const [open, setOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState("");

  // Claim the screen during render (silently) so dialogs rendered later in the
  // same pass (handle prompt, level-up) already see it is the journey's turn.
  if (isStudent && !settledUsers.has(userId) && !holding.current) {
    holding.current = true;
    holdDialog("journey", { silent: true });
  }

  const settle = useCallback(() => {
    if (userId) settledUsers.add(userId);
    if (holding.current) {
      holding.current = false;
      releaseDialog("journey");
    }
  }, [userId]);

  useEffect(() => {
    if (!isStudent || settledUsers.has(userId)) return undefined;
    let active = true;
    fetchJourney()
      .then((data) => {
        if (!active) return;
        const view = normalizeJourney(data);
        if (!view) {
          settle();
          return;
        }
        setJourney(view);
        setOpen(true);
      })
      .catch(() => {
        if (active) settle();
      });
    return () => {
      active = false;
    };
  }, [isStudent, userId, settle]);

  // Never leave the queue blocked when the shell unmounts (sign-out).
  useEffect(
    () => () => {
      if (holding.current) {
        holding.current = false;
        releaseDialog("journey");
      }
    },
    []
  );

  const dismiss = useCallback(() => {
    setOpen(false);
    settle();
    if (dismissed.current) return;
    dismissed.current = true;
    dismissJourney().catch(() => {});
  }, [settle]);

  const share = useCallback(async () => {
    setShareStatus(await shareJourney(journey));
  }, [journey]);

  if (!journey) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      <DialogContent data-testid="journey-welcome" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <p className="text-eyebrow uppercase text-subtle">{journey.active ? "Founding Operative" : "Founding Member"}</p>
          <DialogTitle>Your journey so far</DialogTitle>
          <DialogDescription>
            You studied with us before the platform launched
            {journey.batches.length ? ` (Batch ${journey.batches.join(", ")})` : ""}. Everything you did then now counts: your XP, rank,
            badges and certificates are waiting for you.
          </DialogDescription>
        </DialogHeader>
        <JourneyPanel journey={journey} shareStatus={shareStatus} onShare={share} />
        <DialogFooter className="mt-6 flex justify-end">
          <Button type="button" variant="primary" onClick={dismiss}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
