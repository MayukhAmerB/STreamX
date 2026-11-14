// Shared pieces of the Monthly OSINT CTF pages. OWNER: WS-MONTHLY-CTF.
import { useCallback, useEffect, useRef, useState } from "react";

import { StatusBadge } from "../../kit/Badge";
import { cn } from "../../kit/lib/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../kit/Layout";
import { CosmeticName, HandleAvatar, RankMark, TitleChip, TrophyMark } from "./Cosmetics";
import { seasonErrorKind } from "./seasonApi";
import { countdownFor, formatDuration, phaseLabel, spokenDuration } from "./seasonModel";

/**
 * `useLoad(fetcher, deps)` -> { state: loading|ready|off|missing|signin|error, data, reload }.
 * The fetcher resolves the unwrapped payload; a 403 feature_disabled becomes "off".
 */
export function useLoad(fetcher, deps = []) {
  const [result, setResult] = useState({ state: "loading", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setResult((previous) => (previous.state === "ready" ? previous : { state: "loading", data: null, error: null }));
    Promise.resolve()
      .then(fetcher)
      .then((data) => {
        if (active) setResult({ state: "ready", data, error: null });
      })
      .catch((error) => {
        if (active) setResult({ state: seasonErrorKind(error), data: null, error });
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...result, reload };
}

/** Phase as icon + word (never colour alone). */
export function PhaseBadge({ phase, size = "sm", className }) {
  const kind = { open: "live", upcoming: "soon", closed: "progress", results: "done", off: "soon", none: "soon" }[phase] || "soon";
  return <StatusBadge kind={kind} label={phaseLabel(phase)} size={size} className={className} data-phase={phase} />;
}

/** Milliseconds the server clock is ahead of this device (measured once per server time). */
export function useServerSkew(serverTime) {
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    const server = Date.parse(serverTime || "");
    setSkew(Number.isFinite(server) ? server - Date.now() : 0);
  }, [serverTime]);
  return skew;
}

/** The clock for a countdown: one local re-render a second (no network). */
export function useNow(active = true) {
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const schedule = () => {
      // Whole seconds only while the countdown shows seconds; minutes otherwise.
      const delay = 1000;
      timer.current = window.setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer.current);
  }, [active]);
  return now;
}

/** `serverTime` (from /current/) corrects a wrong device clock. */
export function Countdown({ season, serverTime, className, compact = false }) {
  const live = Boolean(season && (season.phase === "open" || season.phase === "upcoming"));
  const now = useNow(live);
  const skew = useServerSkew(serverTime);
  const countdown = countdownFor(season, now + skew);
  if (!countdown) return null;
  const text = formatDuration(countdown.seconds);
  return (
    <span className={cn("inline-flex items-baseline gap-2", className)}>
      <span className={compact ? "text-xs text-subtle" : "text-sm text-subtle"}>{countdown.label}</span>
      <span className="font-mono tabular-nums text-white" aria-hidden="true">
        {text}
      </span>
      <span className="sr-only">{spokenDuration(countdown.seconds)}</span>
    </span>
  );
}

/**
 * The season board: rank (trophy glyph for the podium), handle with its
 * cosmetics, time and wrong answers. `board` is the API payload.
 */
export function SeasonLeaderboard({ board, caption, emptyText = "No correct answers yet. The first solve takes First Blood.", limit, className }) {
  const rows = (board?.rows || []).slice(0, limit || undefined);
  const me = board?.me && !rows.some((row) => row.is_me) ? board.me : null;
  if (!rows.length) {
    return (
      <div className={cn("rounded-lg border border-dashed border-white/20 px-6 py-10 text-center", className)}>
        <TrophyMark tier="bronze" size={36} className="mx-auto" />
        <p className="mt-4 text-sm text-muted-foreground">{emptyText}</p>
      </div>
    );
  }
  const renderRow = (row, extra = false) => (
    <TableRow key={`${row.rank}-${row.name}`} highlighted={row.is_me} data-rank={row.rank} className={extra ? "border-t border-white/10" : undefined}>
      <TableCell className="w-20 py-3 pl-4 pr-2 sm:pl-5">
        <RankMark rank={row.rank} />
      </TableCell>
      <TableCell className="py-3 pr-2">
        <span className="flex min-w-0 items-center gap-3">
          <HandleAvatar name={row.name} cosmetics={row.cosmetics} size="sm" />
          <span className="min-w-0">
            <CosmeticName name={row.name} cosmetics={row.cosmetics} />
            <span className="mt-0.5 flex flex-wrap items-center gap-2">
              {row.is_me ? <span className="text-eyebrow font-medium uppercase text-accent">You</span> : null}
              {row.first_blood ? <TitleChip>First Blood</TitleChip> : null}
            </span>
          </span>
        </span>
      </TableCell>
      <TableCell className="py-3 text-right font-mono tabular-nums text-white">
        <span aria-hidden="true">{formatDuration(row.score_seconds)}</span>
        <span className="sr-only">{spokenDuration(row.score_seconds)}</span>
      </TableCell>
      <TableCell className="hidden py-3 pr-5 text-right font-mono tabular-nums sm:table-cell">{row.wrong_attempts}</TableCell>
    </TableRow>
  );
  return (
    <Table className={className} wrapperClassName="bg-card">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader>
        <tr>
          <TableHead className="pl-4 pr-2 sm:pl-5">Rank</TableHead>
          <TableHead className="pr-2">Handle</TableHead>
          <TableHead className="text-right">Time</TableHead>
          <TableHead className="hidden pr-5 text-right sm:table-cell">Wrong</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {rows.map((row) => renderRow(row))}
        {me ? renderRow(me, true) : null}
      </TableBody>
    </Table>
  );
}

/** The reward ladder (from the API's `rewards`, or the static copy below). */
export const DEFAULT_REWARDS = [
  { key: "champion", who: "#1", title: "Golden Aura + Season Champion trophy", detail: "A golden glow around your avatar and handle everywhere your profile appears, and a permanent Season Champion trophy.", lasts: "Aura: the following month · Trophy: permanent" },
  { key: "podium", who: "Top 3", title: "Podium frame + gold, silver or bronze trophy", detail: "A golden-white frame around your avatar and a podium trophy for your rank.", lasts: "Frame: the following month · Trophy: permanent" },
  { key: "finalist", who: "Top 10", title: "Finalist badge, Hall of Fame and certificate", detail: "Featured in the Hall of Fame, with a certificate anyone can verify.", lasts: "Permanent" },
  { key: "first_blood", who: "First solver", title: "First Blood title", detail: "The earliest correct answer carries the First Blood title next to their handle.", lasts: "The following month" },
  { key: "operative", who: "Every solver", title: "XP + Monthly Operative badge", detail: "Solve XP on your profile and the Monthly Operative badge, which counts your streak of months.", lasts: "Permanent" },
];

function RewardPreview({ kind }) {
  if (kind === "champion") {
    return (
      <span className="flex items-center gap-4">
        <HandleAvatar name="You" size="lg" cosmetics={{ aura: true }} />
        <TrophyMark tier="gold" size={44} star />
      </span>
    );
  }
  if (kind === "podium") {
    return (
      <span className="flex items-end gap-3">
        <TrophyMark tier="silver" size={34} />
        <TrophyMark tier="gold" size={44} />
        <TrophyMark tier="bronze" size={30} />
      </span>
    );
  }
  if (kind === "finalist") {
    return (
      <span className="flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 font-mono text-xs uppercase tracking-eyebrow text-white">
        Finalist · Top 10
      </span>
    );
  }
  if (kind === "first_blood") return <TitleChip className="px-3 py-1 text-[11px]">First Blood</TitleChip>;
  return (
    <span className="inline-flex items-baseline gap-1 font-mono text-2xl font-semibold tabular-nums text-white">
      +XP<span className="text-xs font-normal text-subtle">streak</span>
    </span>
  );
}

/** Hairline grid of the five reward tiers, each with a real preview of the cosmetic. */
export function RewardGrid({ rewards = DEFAULT_REWARDS, className }) {
  const items = rewards?.length ? rewards : DEFAULT_REWARDS;
  return (
    <ul className={cn("grid gap-3 md:grid-cols-2 md:gap-0 md:overflow-hidden md:rounded-lg md:border-l md:border-t md:border-white/10 lg:grid-cols-3", className)}>
      {items.map((reward) => (
        <li
          key={reward.key}
          className="flex flex-col rounded-lg border border-white/10 bg-surface-1 px-5 py-6 sm:px-6 md:rounded-none md:border-0 md:border-b md:border-r"
        >
          <p className="text-eyebrow font-medium uppercase text-subtle">{reward.who}</p>
          <div className="mt-6 flex min-h-[3.5rem] items-center" aria-hidden="true">
            <RewardPreview kind={reward.key} />
          </div>
          <h3 className="mt-6 !text-lg !font-medium !leading-snug text-white">{reward.title}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{reward.detail}</p>
          <p className="mt-auto pt-5 text-xs text-subtle">{reward.lasts}</p>
        </li>
      ))}
    </ul>
  );
}
