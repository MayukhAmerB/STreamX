// Public page /monthly-ctf/hall-of-fame: every finalised season's top 10.
// OWNER: WS-MONTHLY-CTF.
//
// Catalogue pattern (PHILOSOPHY T3): centred page hero with one Handlee
// accent word, then one tier section per season (header + count + hairline),
// the podium as three cards with luminance trophies, ranks 4-10 as rows.
// Handles only (owner rule: no real names unless an admin turns them on).
import { Link } from "react-router-dom";

import { Button } from "../../kit/Button";
import { Frame, Notice, Section } from "../../kit/Layout";
import { DisplayHeading, Hand, Lead, SectionHeading, Tagline } from "../../kit/Typography";
import { HandleAvatar, TrophyMark } from "./Cosmetics";
import { fetchHallOfFame } from "./seasonApi";
import { PUBLIC_PATH, TIER_LABELS, formatDuration, spokenDuration } from "./seasonModel";
import { useLoad } from "./SeasonParts";

const PODIUM_ORDER = { 1: "md:order-2", 2: "md:order-1", 3: "md:order-3" };

function PodiumCard({ finalist }) {
  const tier = finalist.tier || "bronze";
  const first = finalist.rank === 1;
  return (
    <li className={`flex flex-col items-center rounded-lg border border-white/10 bg-surface-1 px-5 pb-6 pt-7 text-center ${PODIUM_ORDER[finalist.rank] || ""} ${first ? "md:-mt-6" : "md:mt-4"}`}>
      <TrophyMark tier={tier} size={first ? 56 : 44} star={first} />
      <p className="mt-4 text-eyebrow font-medium uppercase text-subtle">
        {first ? "Season Champion" : `${TIER_LABELS[tier]} · ${finalist.rank === 2 ? "2nd" : "3rd"}`}
      </p>
      <span className="mt-4">
        <HandleAvatar name={finalist.name} size="lg" />
      </span>
      <p className="mt-3 max-w-full truncate text-lg font-medium text-white">{finalist.name}</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-muted-foreground">
        <span aria-hidden="true">{formatDuration(finalist.score_seconds)}</span>
        <span className="sr-only">Time {spokenDuration(finalist.score_seconds)}</span>
      </p>
    </li>
  );
}

function SeasonBlock({ season }) {
  const podium = season.finalists.filter((item) => item.rank <= 3);
  const rest = season.finalists.filter((item) => item.rank > 3);
  const headingId = `hof-${season.slug}`;
  return (
    <section aria-labelledby={headingId}>
      <SectionHeading
        id={headingId}
        eyebrow={season.month}
        title={season.title}
        description={`${season.solvers} ${season.solvers === 1 ? "student" : "students"} solved this case.`}
        aside={`${season.finalists.length} finalists`}
      />
      {podium.length ? (
        <ol className="mt-8 grid gap-3 md:grid-cols-3 md:items-end md:gap-4" aria-label={`${season.month} podium`}>
          {podium.map((finalist) => (
            <PodiumCard key={finalist.rank} finalist={finalist} />
          ))}
        </ol>
      ) : null}
      {rest.length ? (
        <ol className="mt-4 divide-y divide-white/10 rounded-lg border border-white/10 bg-card" start={4} aria-label={`${season.month} finalists 4 to 10`}>
          {rest.map((finalist) => (
            <li key={finalist.rank} className="flex items-center gap-4 px-5 py-3.5">
              <span className="w-8 font-mono text-sm tabular-nums text-subtle">{finalist.rank}</span>
              <HandleAvatar name={finalist.name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">{finalist.name}</span>
              <span className="text-eyebrow font-medium uppercase text-subtle">Finalist</span>
              <span className="w-20 text-right font-mono text-sm tabular-nums text-white">{formatDuration(finalist.score_seconds)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {!season.finalists.length ? <p className="mt-6 text-sm text-subtle">Nobody solved this case.</p> : null}
    </section>
  );
}

export default function MonthlyCtfHallOfFamePage() {
  const hof = useLoad(fetchHallOfFame, []);
  const seasons = hof.state === "ready" ? hof.data?.seasons || [] : [];

  return (
    <div className="bg-background text-foreground">
      <Section rhythm="none" className="px-0 pb-16 pt-28 text-center md:pb-24 md:pt-32">
        <Frame width="headline" className="flex flex-col items-center">
          <Tagline>the fastest minds, every month</Tagline>
          <DisplayHeading as="h1" size="hero" className="mt-5">
            <span className="block">
              Hall of <Hand>Fame</Hand>
            </span>
          </DisplayHeading>
          <Lead className="mt-7">
            The top ten of every Monthly OSINT CTF. Champions wear the Golden Aura for the month after their win; trophies and
            certificates stay forever.
          </Lead>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg" trailing="chevron">
              <Link to={PUBLIC_PATH}>This month&apos;s case</Link>
            </Button>
          </div>
        </Frame>
      </Section>
      <Section rhythm="tight" className="pt-0">
        <Frame className="space-y-20">
          {hof.state === "loading" ? <p className="text-center text-sm text-subtle" role="status">Loading the Hall of Fame…</p> : null}
          {hof.state === "off" ? (
            <Notice eyebrow="Opens soon" title="The Monthly CTF has not started yet">
              The Hall of Fame fills up when the first season closes.
            </Notice>
          ) : null}
          {hof.state === "error" ? (
            <Notice eyebrow="Could not load" title="The Hall of Fame did not load" role="alert">
              Check your connection and reload the page.
            </Notice>
          ) : null}
          {hof.state === "ready" && !seasons.length ? (
            <Notice eyebrow="First season" title="No champions yet">
              The first names go up when the first season closes. It could be yours.
            </Notice>
          ) : null}
          {seasons.map((season) => (
            <SeasonBlock key={season.slug} season={season} />
          ))}
        </Frame>
      </Section>
    </div>
  );
}
