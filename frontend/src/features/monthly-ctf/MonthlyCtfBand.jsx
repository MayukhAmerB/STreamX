// Landing band for the Monthly OSINT CTF (mounted by the landing page,
// WS-MKT). OWNER: WS-MONTHLY-CTF.
//
// A display band ("One case. / Every month.") with hand periods, a lead, and
// one real product card: this month's case with its phase, countdown and the
// top three handles. It is fetched after the hero (never on the LCP path) and
// shows the calm "opens soon" copy while the switch is off.
import { Link } from "react-router-dom";

import { Button } from "../../kit/Button";
import { Frame, Section } from "../../kit/Layout";
import { DisplayHeading, Lead } from "../../kit/Typography";
import { CosmeticName, HandleAvatar } from "./Cosmetics";
import { fetchCurrentSeason, fetchSeasonLeaderboard } from "./seasonApi";
import { PUBLIC_PATH, formatDuration } from "./seasonModel";
import { Countdown, PhaseBadge, useLoad } from "./SeasonParts";

export default function MonthlyCtfBand({ className }) {
  const current = useLoad(fetchCurrentSeason, []);
  const season = current.state === "ready" ? current.data?.season || null : null;
  const showBoard = Boolean(season && season.phase !== "upcoming");
  const board = useLoad(() => (showBoard ? fetchSeasonLeaderboard(season.slug, { limit: 3 }) : null), [showBoard, season?.slug]);
  const rows = board.state === "ready" ? board.data?.rows || [] : [];
  const phase = current.state === "off" ? "off" : season?.phase || "none";

  return (
    <Section rhythm="band" className={className} aria-labelledby="mctf-band-title">
      <Frame>
        <DisplayHeading id="mctf-band-title" lines={["One case", "Every month"]} periods />
        <Lead className="mt-6">
          The Monthly OSINT CTF is free for every registered student. Solve the case fastest and wear the Golden Aura for a month;
          every solver earns XP and a streak badge.
        </Lead>
        <div className="mx-auto mt-10 max-w-2xl rounded-xl border border-white/10 bg-card sm:mt-16">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <p className="text-eyebrow font-medium uppercase text-subtle">{season ? season.month : "Monthly CTF"}</p>
              <p className="mt-1 truncate text-lg font-medium text-white">{season ? season.title : "The next case is being prepared"}</p>
            </div>
            <PhaseBadge phase={phase} />
          </div>
          {rows.length ? (
            <ol className="divide-y divide-white/10" aria-label="Top three this month">
              {rows.map((row) => (
                <li key={row.rank} className="flex items-center gap-4 px-5 py-3 sm:px-6">
                  <span className="w-5 font-mono text-sm tabular-nums text-subtle">{row.rank}</span>
                  <HandleAvatar name={row.name} cosmetics={row.cosmetics} size="sm" />
                  <span className="min-w-0 flex-1">
                    <CosmeticName name={row.name} cosmetics={row.cosmetics} />
                  </span>
                  <span className="font-mono text-sm tabular-nums text-white">{formatDuration(row.score_seconds)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-5 py-6 text-sm text-muted-foreground sm:px-6">
              {season?.phase === "open" ? "Nobody has solved it yet. First Blood is still on the table." : "One free case opens on the 1st of every month."}
            </p>
          )}
          <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black px-5 py-3 sm:px-6">
            {season ? <Countdown season={season} serverTime={current.data?.server_time} compact /> : <span className="text-xs text-subtle">Free for students</span>}
            <Button asChild size="sm" variant="secondary" trailing="chevron">
              <Link to={PUBLIC_PATH}>See the case</Link>
            </Button>
          </div>
        </div>
      </Frame>
    </Section>
  );
}
