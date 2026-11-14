// Console › Monthly CTF (/monthly-ctf/play): read the case, submit the flag,
// watch the board, see your trophies. OWNER: WS-MONTHLY-CTF.
//
// Inner app page (PHILOSOPHY T8): golden page eyebrow, 30 -> 36px title, a
// tab bar between two hairlines, cards on #0a0a0a. The answer field is an
// underline field with the golden focus underline; results are announced in
// a polite live region. Nothing here polls: the board refreshes after your
// own submit and when you come back to the tab.
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { Badge } from "../../kit/Badge";
import { Button } from "../../kit/Button";
import { Card } from "../../kit/Card";
import { DisabledReason } from "../../kit/DisabledReason";
import { Notice } from "../../kit/Layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../kit/Tabs";
import { Eyebrow, PageTitle } from "../../kit/Typography";
import { useAuth } from "../../hooks/useAuth";
import { apiMessage } from "../../utils/api";
import { CosmeticName, HandleAvatar, TrophyCard, TrophyMark, cosmeticWords } from "./Cosmetics";
import { fetchCurrentSeason, fetchMySeasonSummary, fetchSeasonLeaderboard, seasonErrorKind, submitSeasonAnswer } from "./seasonApi";
import {
  DIFFICULTY_LABELS,
  HALL_OF_FAME_PATH,
  PUBLIC_PATH,
  briefParagraphs,
  certificatePath,
  formatDuration,
  formatIst,
  ordinal,
  spokenDuration,
} from "./seasonModel";
import { Countdown, PhaseBadge, RewardGrid, SeasonLeaderboard, useLoad } from "./SeasonParts";
import { primeCosmetics } from "./useMyCosmetics";

function useRefreshOnFocus(reload) {
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);
}

function EntrySummary({ season }) {
  const me = season.me;
  if (!me?.joined) {
    return <p className="text-sm text-muted-foreground">No answers yet. Your clock is the season&apos;s clock: it started {formatIst(season.opens_at)}.</p>;
  }
  if (me.solved) {
    return (
      <dl className="grid grid-cols-3 gap-4 text-center">
        <div>
          <dt className="text-eyebrow font-medium uppercase text-subtle">Rank</dt>
          <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{me.rank ? ordinal(me.rank) : "—"}</dd>
        </div>
        <div>
          <dt className="text-eyebrow font-medium uppercase text-subtle">Time</dt>
          <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">
            <span aria-hidden="true">{formatDuration(me.score_seconds)}</span>
            <span className="sr-only">{spokenDuration(me.score_seconds)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-eyebrow font-medium uppercase text-subtle">Wrong</dt>
          <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{me.wrong_attempts}</dd>
        </div>
      </dl>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {me.wrong_attempts} wrong {me.wrong_attempts === 1 ? "answer" : "answers"} so far · {me.attempts_left} attempts left.
    </p>
  );
}

/** The polite live region with the last answer's outcome (outlives the form once solved). */
function ResultLine({ result }) {
  return (
    <div aria-live="polite" role="status" className="mt-4 min-h-[1.5rem]">
      {result ? (
        <p className="flex items-center gap-2 text-sm" data-result={result.tone}>
          <Badge variant={result.tone === "correct" ? "solid" : result.tone === "wrong" ? "outline" : "muted"} size="sm">
            {result.tone === "correct" ? "Correct" : result.tone === "wrong" ? "Not correct" : "Note"}
          </Badge>
          <span className="text-[#d4d4d4]">{result.text}</span>
        </p>
      ) : null}
    </div>
  );
}

function AnswerForm({ season, onSubmitted, setResult }) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const inputRef = useRef(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const text = answer.trim();
    if (!text) {
      setResult({ tone: "info", text: "Type your answer first." });
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const { message, data } = await submitSeasonAnswer(season.slug, text);
      const tone = data?.correct ? "correct" : "wrong";
      setResult({ tone, text: message || (data?.correct ? "Correct." : "Not quite.") });
      if (data?.correct) setAnswer("");
      onSubmitted?.(data);
    } catch (error) {
      const kind = seasonErrorKind(error);
      setResult({ tone: "info", text: kind === "off" ? "The Monthly CTF was switched off a moment ago." : apiMessage(error, "Could not send your answer. Try again.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="mt-6" aria-describedby={hintId}>
      <label htmlFor={fieldId} className="text-[11px] text-subtle">
        Your answer
      </label>
      <div className="mt-1 flex flex-col gap-4 sm:flex-row sm:items-end">
        <input
          ref={inputRef}
          id={fieldId}
          name="answer"
          autoComplete="off"
          spellCheck="false"
          maxLength={512}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={season.flag_format || "Type the flag"}
          className="h-11 w-full flex-1 border-0 border-b border-white/35 bg-transparent px-0 font-mono text-sm text-white placeholder:text-[#737373] focus:border-accent focus:outline-none focus-visible:outline-none"
        />
        <Button type="submit" size="md" variant="accent" disabled={busy} className="sm:w-auto" trailing="chevron">
          {busy ? "Checking…" : "Submit answer"}
        </Button>
      </div>
      <p id={hintId} className="mt-3 text-xs text-subtle">
        Each wrong answer adds {formatDuration(season.penalty_seconds)} to your time. Capitals and extra spaces do not matter.
      </p>
    </form>
  );
}

function CaseFile({ season, onSubmitted, result, setResult }) {
  const paragraphs = briefParagraphs(season.brief);
  const canAnswer = season.can_play && season.phase === "open";
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card className="p-6 sm:p-8">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{DIFFICULTY_LABELS[season.difficulty] || season.difficulty}</Badge>
          {(season.skills || []).map((skill) => (
            <Badge key={skill} variant="chip" size="md">
              {skill}
            </Badge>
          ))}
        </div>
        {season.content_visible ? (
          <>
            <div className="mt-6 space-y-4 text-base leading-7 text-[#d4d4d4]">
              {paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
            <div className="mt-8 border-t border-white/10 pt-6">
              <Eyebrow>Question</Eyebrow>
              <p className="mt-2 text-lg font-medium text-white">{season.question}</p>
              {season.flag_format ? <p className="mt-1 text-sm text-subtle">Format: {season.flag_format}</p> : null}
              {season.materials_url ? (
                <a
                  href={season.materials_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-sm text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Open the starting material ↗<span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null}
            </div>
            {canAnswer ? (
              <AnswerForm season={season} onSubmitted={onSubmitted} setResult={setResult} />
            ) : (
              <div className="mt-6">
                <DisabledReason reason={season.play_reason || "Answers are closed."} size="md" icon={season.me?.solved ? "none" : "clock"}>
                  Submit answer
                </DisabledReason>
              </div>
            )}
            <ResultLine result={result} />
          </>
        ) : (
          <p className="mt-6 text-sm leading-6 text-muted-foreground">
            The case file opens {formatIst(season.opens_at)}. Come back then; your clock starts with everyone else&apos;s.
          </p>
        )}
      </Card>
      <div className="space-y-6">
        <Card className="p-6">
          <Eyebrow>Your entry</Eyebrow>
          <div className="mt-4">
            <EntrySummary season={season} />
          </div>
        </Card>
        <Card className="p-6">
          <Eyebrow>This season</Eyebrow>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-subtle">Opens</dt>
              <dd className="text-right text-white">{formatIst(season.opens_at)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-subtle">Closes</dt>
              <dd className="text-right text-white">{formatIst(season.closes_at)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-subtle">Solved</dt>
              <dd className="font-mono tabular-nums text-white">
                {season.solvers} / {season.participants}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-subtle">Solve XP</dt>
              <dd className="font-mono tabular-nums text-white">{season.solve_xp}</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

function MyRewards({ summary }) {
  if (summary.state === "loading") return <p className="text-sm text-subtle">Loading your trophies…</p>;
  if (summary.state !== "ready" || !summary.data) return <p className="text-sm text-subtle">Your trophies could not be loaded.</p>;
  const data = summary.data;
  const words = cosmeticWords(data.cosmetics);
  return (
    <div className="space-y-10">
      <Card className="flex flex-col items-start gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
        <HandleAvatar name={data.display_name || data.handle} size="xl" cosmetics={data.cosmetics} animated />
        <div className="min-w-0">
          <Eyebrow>Your public handle</Eyebrow>
          <p className="mt-1 text-2xl font-semibold">
            <CosmeticName name={data.display_name || data.handle} cosmetics={data.cosmetics} />
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {words.length ? `Active: ${words.join(" · ")}${data.cosmetics?.until ? ` until ${formatIst(data.cosmetics.until, { withTime: false })}` : ""}.` : "No active cosmetics this month."}
          </p>
        </div>
        <dl className="grid w-full grid-cols-3 gap-4 border-t border-white/10 pt-6 text-center sm:ml-auto sm:w-auto sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0">
          <div>
            <dt className="text-eyebrow font-medium uppercase text-subtle">Streak</dt>
            <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{data.streak_months}</dd>
          </div>
          <div>
            <dt className="text-eyebrow font-medium uppercase text-subtle">Solved</dt>
            <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{data.seasons_solved}</dd>
          </div>
          <div>
            <dt className="text-eyebrow font-medium uppercase text-subtle">XP</dt>
            <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">{data.xp_earned}</dd>
          </div>
        </dl>
      </Card>

      <section aria-labelledby="mctf-trophies">
        <h2 id="mctf-trophies" className="!text-xl !font-semibold text-white">
          Trophies
        </h2>
        {data.trophies?.length ? (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.trophies.map((trophy) => (
              <li key={`${trophy.season}-${trophy.kind}`}>
                <TrophyCard tier={trophy.tier || "gold"} star={trophy.kind === "season_champion"} title={trophy.title} caption={trophy.rank ? `Rank ${trophy.rank}` : null} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-subtle">Finish in the top 3 to put a trophy here. Trophies are permanent.</p>
        )}
      </section>

      <section aria-labelledby="mctf-badges">
        <h2 id="mctf-badges" className="!text-xl !font-semibold text-white">
          Badges and certificates
        </h2>
        {data.badges?.length || data.certificates?.length ? (
          <ul className="mt-4 divide-y divide-white/10 rounded-lg border border-white/10 bg-card">
            {(data.badges || []).map((badge) => (
              <li key={`${badge.season}-${badge.kind}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <span className="text-sm font-medium text-white">{badge.title}</span>
                <span className="text-xs text-subtle">{badge.streak ? `Streak ${badge.streak} month${badge.streak === 1 ? "" : "s"}` : badge.month}</span>
              </li>
            ))}
            {(data.certificates || []).map((item) => (
              <li key={`${item.season}-cert`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <span className="text-sm font-medium text-white">{item.title}</span>
                <Link
                  to={certificatePath(item.certificate_slug)}
                  className="text-sm text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  View and share →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-subtle">Solve a season to earn the Monthly Operative badge.</p>
        )}
      </section>
    </div>
  );
}

function OffState() {
  return (
    <Notice eyebrow="Opens soon" title="The Monthly CTF is not open yet" role="status">
      When it opens, one free OSINT case goes live every month for every registered student, with its own board and rewards.{" "}
      <Link to={PUBLIC_PATH} className="text-white underline underline-offset-4">
        Read how it works
      </Link>
      .
    </Notice>
  );
}

export default function MonthlyCtfPlayPage() {
  const auth = useAuth() || {};
  const current = useLoad(fetchCurrentSeason, []);
  const season = current.state === "ready" ? current.data?.season || null : null;
  const slug = season?.slug || "";
  const showBoard = Boolean(season && season.phase !== "upcoming");
  const [boardNonce, setBoardNonce] = useState(0);
  const board = useLoad(
    () => (showBoard ? fetchSeasonLeaderboard(slug, { limit: 25, fresh: boardNonce > 0 }) : null),
    [showBoard, slug, boardNonce]
  );
  const summary = useLoad(() => (current.state === "off" ? null : fetchMySeasonSummary({ fresh: true })), [current.state]);
  const [tab, setTab] = useState("case");
  const [result, setResult] = useState(null); // last answer: { tone: "correct"|"wrong"|"info", text }

  useRefreshOnFocus(current.reload);

  useEffect(() => {
    if (summary.state === "ready" && summary.data?.cosmetics && auth.user?.id != null) {
      primeCosmetics(auth.user.id, summary.data.cosmetics);
    }
  }, [summary.state, summary.data, auth.user?.id]);

  // Opening the board fetches it fresh (one request per visit to the tab; nothing polls).
  const openTab = (next) => {
    setTab(next);
    if (next === "board") setBoardNonce((value) => value + 1);
  };

  const onSubmitted = (data) => {
    current.reload();
    if (data?.correct) setBoardNonce((value) => value + 1);
  };

  return (
    <div className="mx-auto w-full max-w-6xl text-foreground" data-page="monthly-ctf">
      <Eyebrow tone="accent">{season ? `Monthly CTF · ${season.month}` : "Monthly CTF"}</Eyebrow>
      <PageTitle className="mt-2 !text-3xl !font-semibold !leading-tight sm:!text-4xl">{season ? season.title : "This month's case"}</PageTitle>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
        {season?.tagline || "One free OSINT case every month. Fastest clean solve wins; every solver earns XP."}
      </p>
      {season ? (
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PhaseBadge phase={season.phase} />
          <Countdown season={season} serverTime={current.data?.server_time} />
          {season.me?.solved && season.me.rank ? (
            <Badge variant="solid" size="sm">
              Solved · {ordinal(season.me.rank)}
            </Badge>
          ) : null}
        </div>
      ) : null}

      {current.state === "off" ? (
        <div className="mt-8">
          <OffState />
        </div>
      ) : current.state === "loading" ? (
        <p className="mt-8 text-sm text-subtle" role="status">
          Loading this month&apos;s case…
        </p>
      ) : current.state !== "ready" ? (
        <Notice className="mt-8" eyebrow="Could not load" title="The case file did not load" role="alert">
          Check your connection and try again.{" "}
          <button type="button" onClick={current.reload} className="text-white underline underline-offset-4">
            Retry
          </button>
        </Notice>
      ) : !season ? (
        <Notice className="mt-8" eyebrow="Between seasons" title="The next case is being prepared" role="status">
          A new case opens on the 1st. Meanwhile, browse the{" "}
          <Link to={HALL_OF_FAME_PATH} className="text-white underline underline-offset-4">
            Hall of Fame
          </Link>
          .
        </Notice>
      ) : (
        <Tabs value={tab} onValueChange={openTab} className="mt-8">
          <TabsList aria-label="Monthly CTF">
            <TabsTrigger value="case">Case file</TabsTrigger>
            <TabsTrigger value="board">Leaderboard</TabsTrigger>
            <TabsTrigger value="rewards">My trophies</TabsTrigger>
          </TabsList>
          <TabsContent value="case">
            <CaseFile season={season} onSubmitted={onSubmitted} result={result} setResult={setResult} />
          </TabsContent>
          <TabsContent value="board">
            {showBoard ? (
              board.state === "ready" && board.data ? (
                <>
                  <SeasonLeaderboard board={board.data} caption={`${season.month} leaderboard`} />
                  <p className="mt-4 text-xs text-subtle">
                    Ranked by time since the case opened plus {formatDuration(board.data.penalty_seconds)} per wrong answer; ties go to the earlier solve.
                  </p>
                </>
              ) : (
                <p className="text-sm text-subtle">Loading the board…</p>
              )
            ) : (
              <SeasonLeaderboard board={{ rows: [] }} emptyText="The board opens with the case." />
            )}
          </TabsContent>
          <TabsContent value="rewards">
            <MyRewards summary={summary} />
            <div className="mt-12">
              <h2 className="!text-xl !font-semibold text-white">How rewards work</h2>
              <RewardGrid rewards={current.data?.rewards} className="mt-4" />
            </div>
            <div className="mt-8 flex items-center gap-3">
              <TrophyMark tier="gold" size={24} />
              <Link to={HALL_OF_FAME_PATH} className="text-sm text-white underline-offset-4 hover:underline">
                Hall of Fame →
              </Link>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
