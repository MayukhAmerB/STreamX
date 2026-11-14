// Public page /monthly-ctf: the free Monthly OSINT CTF. OWNER: WS-MONTHLY-CTF.
//
// HackPath philosophy (PHILOSOPHY T1/T2): a centred hero (handwritten
// tagline, one Handlee accent word, a stat strip), a numbered timeline that
// shows real product UI (the case file, the answer field, the live board),
// the reward ladder in a hairline grid, and the live top 10. While the
// `monthly_ctf` switch is off the page stays visible and the play action is
// disabled with its reason (disable, never hide).
import { Link } from "react-router-dom";

import { Badge } from "../../kit/Badge";
import { Button } from "../../kit/Button";
import { DisabledReason } from "../../kit/DisabledReason";
import { Frame, Section, StatStrip } from "../../kit/Layout";
import { Timeline, TimelineStep } from "../../kit/Story";
import { DisplayHeading, Hand, Kicker, Lead, SectionHeading, Tagline } from "../../kit/Typography";
import { useAuth } from "../../hooks/useAuth";
import { CosmeticName, HandleAvatar, TitleChip } from "./Cosmetics";
import { fetchCurrentSeason, fetchSeasonLeaderboard } from "./seasonApi";
import { DIFFICULTY_LABELS, HALL_OF_FAME_PATH, formatDuration, formatIst, playTarget } from "./seasonModel";
import { Countdown, PhaseBadge, RewardGrid, SeasonLeaderboard, useLoad } from "./SeasonParts";

const OFF_REASON = "The Monthly CTF is not open yet. It will be free for every registered student.";

function heroAction(state, season, signedIn) {
  if (state === "off") return { disabled: true, reason: OFF_REASON };
  if (state !== "ready") return { disabled: true, reason: "Checking this month's case…" };
  if (!season) return { disabled: true, reason: "The next case is being prepared. Check back on the 1st." };
  if (season.phase === "upcoming") return { disabled: true, reason: `This month's case opens ${formatIst(season.opens_at)}.` };
  if (season.phase === "closed") return { disabled: true, reason: "This case has closed. Results are being checked." };
  if (season.phase === "results") return { disabled: true, reason: "This case is over. The next one opens on the 1st." };
  return { disabled: false, to: playTarget(signedIn), label: signedIn ? "Open the case file" : "Sign in to play" };
}

function CaseFilePreview({ season }) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs uppercase tracking-eyebrow text-subtle">Case file · {season?.month || "this month"}</p>
        <Badge variant="outline">{DIFFICULTY_LABELS[season?.difficulty] || "Medium"}</Badge>
      </div>
      <p className="mt-4 text-lg font-medium text-white">{season?.title || "A photo, a harbour and a missing date"}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {season?.tagline || "Every case starts from public material. Read it, investigate in the open, and work out the one fact that answers the question."}
      </p>
      {season?.skills?.length ? (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Skills">
          {season.skills.map((skill) => (
            <li key={skill}>
              <Badge variant="chip" size="md">
                {skill}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AnswerPreview({ penalty }) {
  return (
    <div className="rounded-xl border border-white/10 bg-card p-5 sm:p-6" aria-hidden="true">
      <p className="text-[11px] text-subtle">Your answer</p>
      <div className="mt-2 flex items-end gap-3">
        <span className="h-10 flex-1 border-b border-white/35 pb-2 font-mono text-sm text-[#737373]">type the flag…</span>
        <span className="inline-flex h-10 items-center rounded-md bg-white px-5 text-sm font-medium text-black">Submit</span>
      </div>
      <p className="mt-4 text-xs text-subtle">Each wrong answer adds {formatDuration(penalty || 600)} to your time.</p>
    </div>
  );
}

function BoardPreview({ board }) {
  const rows = board?.rows?.length
    ? board.rows.slice(0, 3)
    : [
        { rank: 1, name: "QuietFalcon42", score_seconds: 5420, cosmetics: { aura: true }, first_blood: true },
        { rank: 2, name: "LunarLedger17", score_seconds: 7210, cosmetics: { frame: true } },
        { rank: 3, name: "SteadyCipher63", score_seconds: 9930, cosmetics: { frame: true } },
      ];
  return (
    <ol className="divide-y divide-white/10 rounded-xl border border-white/10 bg-card" aria-label={board?.rows?.length ? "Current top three" : "Example board"}>
      {rows.map((row) => (
        <li key={row.rank} className="flex items-center gap-4 px-5 py-3.5">
          <span className="w-6 font-mono text-sm tabular-nums text-subtle">{row.rank}</span>
          <HandleAvatar name={row.name} cosmetics={row.cosmetics} size="sm" />
          <span className="min-w-0 flex-1">
            <CosmeticName name={row.name} cosmetics={row.cosmetics} showTitle={false} />
          </span>
          {row.first_blood ? <TitleChip className="hidden sm:inline-flex">First Blood</TitleChip> : null}
          <span className="font-mono text-sm tabular-nums text-white">{formatDuration(row.score_seconds)}</span>
        </li>
      ))}
    </ol>
  );
}

export default function MonthlyCtfPage() {
  const auth = useAuth() || {};
  const signedIn = Boolean(auth.user);
  const current = useLoad(fetchCurrentSeason, []);
  const season = current.state === "ready" ? current.data?.season || null : null;
  const showBoard = Boolean(season && season.phase !== "upcoming");
  const board = useLoad(() => (showBoard ? fetchSeasonLeaderboard(season.slug, { limit: 10 }) : null), [showBoard, season?.slug]);
  const action = heroAction(current.state, season, signedIn);
  const phase = current.state === "off" ? "off" : season?.phase || "none";
  const rewards = current.data?.rewards;

  const stats = [
    { value: season ? String(season.solvers) : "—", label: "solved" },
    { value: season ? String(season.participants) : "—", label: "playing" },
    { value: season ? `${season.solve_xp} XP` : "Free", label: season ? "per solve" : "for students" },
    { value: season ? season.month : "Monthly", label: "season" },
  ];

  return (
    <div className="bg-background text-foreground">
      <Section rhythm="none" className="flex min-h-[100svh] flex-col items-center justify-center px-0 pb-20 pt-28 text-center md:pt-32">
        <Frame width="headline" className="flex flex-col items-center">
          <Kicker lead="Monthly CTF">Free for every student</Kicker>
          <Tagline className="mt-5">one case, every month</Tagline>
          <DisplayHeading as="h1" size="hero" className="mt-5 max-w-5xl">
            <span className="block">Solve the</span>
            <span className="block">
              month&apos;s <Hand>case</Hand>
            </span>
          </DisplayHeading>
          <Lead className="mt-7">
            A new open-source intelligence challenge opens on the 1st of every month. Every registered student plays free, no
            membership needed. The fastest clean solve wears the Golden Aura for a month.
          </Lead>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <PhaseBadge phase={phase} size="md" />
            {season ? <Countdown season={season} serverTime={current.data?.server_time} /> : null}
          </div>
          <div className="mt-8 flex flex-wrap items-start justify-center gap-3">
            {action.disabled ? (
              <DisabledReason reason={action.reason} size="lg" align="center" icon="clock">
                Play this month&apos;s case
              </DisabledReason>
            ) : (
              <Button asChild size="lg" trailing="chevron">
                <Link to={action.to}>{action.label}</Link>
              </Button>
            )}
            <Button asChild size="lg" variant="secondary">
              <Link to={HALL_OF_FAME_PATH}>Hall of Fame</Link>
            </Button>
          </div>
          <StatStrip className="mt-12" items={stats} />
        </Frame>
      </Section>

      <Section rhythm="band" aria-labelledby="mctf-how">
        <Frame>
          <DisplayHeading id="mctf-how" lines={["Read first", "Answer after"]} periods />
          <Lead className="mt-6">
            The board ranks by time, not luck. Your clock starts when the case opens, and every wrong answer before your solve
            costs a penalty, so careful beats fast-and-noisy.
          </Lead>
          <div className="mt-10 grid gap-12 sm:mt-16 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <p className="eyebrow">How it is ranked</p>
              <h3 className="mt-3 text-3xl font-semibold leading-tight text-white sm:text-4xl">One flag. One clock.</h3>
              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Ties go to whoever solved first, so no two people share a rank.
              </p>
              <ul className="mt-8 space-y-5 text-sm leading-6">
                {[
                  ["Free.", "Every registered student plays; no membership or lab access needed."],
                  ["Public handles.", "Boards show your handle, never your real name."],
                  ["One season a month.", "It opens and closes on its own; results are final at close."],
                  ["Fair play.", "Answers are checked on the server and never shown to anyone."],
                ].map(([lead, rest]) => (
                  <li key={lead} className="flex gap-3">
                    <span aria-hidden="true" className="mt-1.5 inline-block size-2 shrink-0 rounded-full bg-white/60" />
                    <span>
                      <strong className="font-semibold text-white">{lead}</strong>{" "}
                      <span className="text-muted-foreground">{rest}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <Timeline>
              <TimelineStep number={1} kicker="Day 1" title="Open the case file" sub="A brief, a question and a flag format. Everything you need is public.">
                <CaseFilePreview season={season} />
              </TimelineStep>
              <TimelineStep number={2} kicker="Any time this month" title="Submit your flag" sub="Your time is the moment of your correct answer, plus the penalty for each wrong one.">
                <AnswerPreview penalty={season?.penalty_seconds} />
              </TimelineStep>
              <TimelineStep number={3} kicker="Live" title="Climb the board" sub="The board updates as people solve. The first correct answer takes First Blood.">
                <BoardPreview board={board.state === "ready" ? board.data : null} />
              </TimelineStep>
              <TimelineStep number={4} kicker="At close" title="Rewards land on their own" sub="When the season closes the results are final and every reward is granted automatically." last>
                <div className="flex flex-wrap items-center gap-4 rounded-xl border border-white/10 bg-card p-5 sm:p-6">
                  <HandleAvatar name="Champion" size="lg" cosmetics={{ aura: true }} animated />
                  <div className="min-w-0">
                    <p className="text-eyebrow font-medium uppercase text-subtle">Season Champion</p>
                    <p className="mt-1 text-base font-medium text-white">Golden Aura for the whole of next month</p>
                  </div>
                </div>
              </TimelineStep>
            </Timeline>
          </div>
        </Frame>
      </Section>

      <Section aria-labelledby="mctf-rewards">
        <Frame>
          <SectionHeading as="h2" id="mctf-rewards" title="What you can win" description="Cosmetics last for the following month. Trophies, badges and certificates are yours to keep." aside="5 reward tiers" />
          <RewardGrid rewards={rewards} className="mt-6" />
        </Frame>
      </Section>

      <Section aria-labelledby="mctf-board">
        <Frame>
          <SectionHeading
            as="h2"
            id="mctf-board"
            title={season?.phase === "results" ? `${season.month}: final results` : "This month's board"}
            description={season ? season.title : "The board opens with the next case."}
            aside={season ? `${season.solvers} solved · ${season.participants} playing` : null}
          />
          <div className="mt-6">
            {board.state === "ready" && board.data ? (
              <SeasonLeaderboard board={board.data} caption="Monthly CTF leaderboard, top 10" limit={10} />
            ) : (
              <SeasonLeaderboard board={{ rows: [] }} emptyText={showBoard ? "Loading the board…" : "The board opens with the next case."} />
            )}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild variant="secondary" trailing="chevron">
              <Link to={HALL_OF_FAME_PATH}>See past champions</Link>
            </Button>
          </div>
        </Frame>
      </Section>
    </div>
  );
}
