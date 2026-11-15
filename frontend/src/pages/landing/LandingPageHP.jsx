// The public landing page in the HackPath philosophy (PHILOSOPHY T1/T2/T5,
// BUILD_PLAN §2.1 "/"): black canvas, a signal-accent hero (headline, a tilted
// investigation board, the two categories and the live site figures), real product UI in a numbered
// timeline, batches & live classes, packages, rewards, the open programmes and
// live classes (same data and states as before), the Watch band and the footer
// wordmark (layout).
import { Link as RouterLink } from "react-router-dom";

import { siteBrand } from "../../config/siteBrand";
import { LEVELS } from "../../features/engagement-ui/engagementModel";
import { useYouTubeChannel } from "../../features/youtube/youTubeStore";
import { useAuth } from "../../hooks/useAuth";
import { CardShell } from "../../marketing/CatalogCard";
import {
  CertificateMock,
  ClassroomMock,
  ExamMock,
  PlayerMock,
  ReportMock,
  TerminalMock,
  TrackPickerMock,
} from "../../marketing/Mocks";
import { mergePlans, OSINT_PLANS, planPriceLabel, rupees } from "../../marketing/plans";
import {
  ButtonLink,
  CheckIcon,
  CheckList,
  DisplayHeading,
  Eyebrow,
  Hand,
  StatStrip,
  StatusPill,
} from "../../marketing/primitives";
import SiteStatStrip from "../../marketing/SiteStatStrip";
import { useSiteStats } from "../../marketing/siteStats";
import { useMarketingData } from "../../marketing/useMarketingData";
import { FREE_TIER } from "../../data/freeLabs";
import { getCourseCategoryPath } from "../../utils/courseCatalog";
import { BestsellersContent } from "./BestsellersBand";
import { HeroCountdownStrip } from "./HeroBand";
import {
  HP_BATCHES,
  HP_COMMUNITY,
  HP_HERO_BOARD,
  HP_HERO_TRACE,
  HP_HERO_TRACKS,
  HP_HERO,
  HP_OPEN_NOW,
  HP_PACKAGES,
  HP_REWARDS,
  HP_STORY,
  HP_TRACKS,
} from "./landingContent";
import LiveClassesBand from "./LiveClassesBand";
import { useHashScroll } from "./useHashScroll";
import { liveBroadcastJoinPath, useLandingLiveClasses, useHeroLiveBroadcast } from "./useLandingData";
import WatchBand, { watchBandVisible } from "./WatchBand";
import "./landing.css";

/**
 * The hero's figures from GET /api/site/stats/ (via siteStats.js), in the
 * order a visitor cares about: students trained, verified reviews, average
 * rating, live classes held. A figure the server left out (null / below its
 * minimum) is simply not shown; no figure at all means no strip.
 */
export function heroStatItems(items = []) {
  const byKey = Object.fromEntries((Array.isArray(items) ? items : []).map((item) => [item.key, item]));
  const rows = [];
  const students = byKey.students_enrolled;
  if (students) rows.push({ ...students, label: "Students trained" });
  const rating = byKey.average_rating;
  if (rating && typeof rating.reviews === "number") {
    rows.push({ key: "rating_count", label: "Verified reviews", value: String(rating.reviews), count: rating.reviews, plus: false, note: "" });
  }
  if (rating) rows.push({ ...rating, label: "Average rating", note: "" });
  const classes = byKey.live_classes_delivered;
  if (classes) rows.push({ ...classes, label: "Live classes held" });
  return rows;
}

/** The case file: one OSINT case, pivot by pivot, ending in "case closed". */
export function TraceConsole({ steps = HP_HERO_TRACE.steps }) {
  return (
    <figure className="hp-console" aria-labelledby="hp-console-caption">
      <div className="hp-console__bar" aria-hidden="true">
        <span className="hp-console__dots">
          <span />
          <span />
          <span />
        </span>
        <span className="hp-console__title">{HP_HERO_TRACE.title}</span>
      </div>
      <div className="hp-console__body">
        <p className="hp-console__cmd">
          <span className="hp-console__prompt" aria-hidden="true">
            $
          </span>{" "}
          {HP_HERO_TRACE.command}
        </p>
        <ol className="hp-console__steps">
          {steps.map((step, index) => (
            <li key={step.tag} className="hp-console__step" style={{ "--hp-step": index + 1 }}>
              <span className="hp-console__num" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="hp-console__tag">{step.tag}</span>
              <span className="hp-console__detail">{step.detail}</span>
            </li>
          ))}
        </ol>
        <div className="hp-console__meter" aria-hidden="true">
          <span>{HP_HERO_TRACE.progress}</span>
          <span className="hp-console__track">
            <span className="hp-console__fill" />
          </span>
          <span>100%</span>
        </div>
        <p className="hp-console__done" style={{ "--hp-step": steps.length + 1 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
            <path d="M6.5 11.2 3.3 8l-.7.7 3.9 3.9 7-7-.7-.7z" />
          </svg>
          <span>
            {HP_HERO_TRACE.closed}
            <span className="hp-console__cursor" aria-hidden="true" />
          </span>
        </p>
      </div>
      <figcaption id="hp-console-caption" className="hp-sr">
        {HP_HERO_TRACE.caption}
      </figcaption>
    </figure>
  );
}

/* The trace map: a wireframe globe (viewBox 400) with the case photo at the
   centre and one arc per pivot. Presentation only, so the coordinates live here. */
const MAP_TARGET = [262, 168];
const MAP_NODES = [
  [88, 236],
  [326, 96],
  [122, 270],
  [226, 350],
  [318, 336],
];

function arcPath([x1, y1], [x2, y2]) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const bend = 0.28;
  return `M${x1} ${y1}Q${Math.round(mx - (y2 - y1) * bend)} ${Math.round(my + (x2 - x1) * bend)} ${x2} ${y2}`;
}

/** A deterministic QR-like pattern (finder squares in three corners); decoration only. */
export function qrModules(size = 17, seed = 419) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const finder = (x, y) => {
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      const dx = x - ox;
      const dy = y - oy;
      if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) {
        const ring = Math.min(dx, dy, 6 - dx, 6 - dy);
        return ring !== 1;
      }
      if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) return false;
    }
    return null;
  };
  let path = "";
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const fixed = finder(x, y);
      if (fixed ?? next() > 0.52) path += `M${x} ${y}h1v1h-1z`;
    }
  }
  return path;
}

const QR_PATH = qrModules();

function TraceMap() {
  const labels = HP_HERO_BOARD.map.nodes;
  return (
    <div className="hx-map" aria-hidden="true">
      <span className="hx-map__sweep" />
      <svg className="hx-map__svg" viewBox="0 0 400 400" focusable="false">
        <defs>
          <linearGradient id="hx-arc-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="hx-stop-a" />
            <stop offset="1" className="hx-stop-b" />
          </linearGradient>
          <radialGradient id="hx-globe-fill" cx="0.38" cy="0.32" r="0.75">
            <stop offset="0" className="hx-stop-glow" />
            <stop offset="1" className="hx-stop-none" />
          </radialGradient>
        </defs>
        <circle className="hx-map__ring hx-map__ring--outer" cx="200" cy="200" r="194" />
        <circle className="hx-map__ring hx-map__ring--mid" cx="200" cy="200" r="172" />
        <circle className="hx-map__globe" cx="200" cy="200" r="150" />
        <g className="hx-map__lat">
          <ellipse cx="200" cy="200" rx="150" ry="22" />
          <ellipse cx="200" cy="125" rx="130" ry="18" />
          <ellipse cx="200" cy="275" rx="130" ry="18" />
          <ellipse cx="200" cy="70" rx="75" ry="10" />
          <ellipse cx="200" cy="330" rx="75" ry="10" />
        </g>
        <g className="hx-map__lon">
          <ellipse cx="200" cy="200" rx="150" ry="150" />
          <ellipse cx="200" cy="200" rx="110" ry="150" />
          <ellipse cx="200" cy="200" rx="56" ry="150" />
        </g>
        <g className="hx-map__arcs">
          {MAP_NODES.map((node, index) => (
            <path key={labels[index]} d={arcPath(MAP_TARGET, node)} style={{ "--hx-i": index }} />
          ))}
        </g>
        <g className="hx-map__nodes">
          {MAP_NODES.map(([x, y], index) => (
            <g key={labels[index]} style={{ "--hx-i": index }}>
              <circle className="hx-map__ping" cx={x} cy={y} r="9" />
              <circle className="hx-map__node" cx={x} cy={y} r="3.5" />
              <text x={x + 9} y={y - 9}>
                {labels[index]}
              </text>
            </g>
          ))}
          <circle className="hx-map__ping hx-map__ping--target" cx={MAP_TARGET[0]} cy={MAP_TARGET[1]} r="14" />
          <circle className="hx-map__target" cx={MAP_TARGET[0]} cy={MAP_TARGET[1]} r="6" />
          <text className="hx-map__target-label" x={MAP_TARGET[0] + 14} y={MAP_TARGET[1] - 12}>
            {HP_HERO_BOARD.map.target}
          </text>
        </g>
      </svg>
    </div>
  );
}

/**
 * The hero's focal visual: a tilted investigation board. The trace map sits at
 * the back; the case file, a located pin, the CTF leaderboard (handles only)
 * and a certificate with its QR float in front at different depths.
 */
export function InvestigationBoard() {
  const { pin, leaderboard, certificate } = HP_HERO_BOARD;
  return (
    <div className="hx-stage">
      <p className="hp-sr">{HP_HERO_BOARD.caption}</p>
      <div className="hx-board">
        <span className="hx-corners" aria-hidden="true" />
        <p className="hx-status" aria-hidden="true">
          <span className="hx-status__dot" />
          {HP_HERO_BOARD.status}
          <span className="hx-status__sep">/</span>
          {HP_HERO_BOARD.sources}
        </p>
        <TraceMap />
        <div className="hx-layer hx-layer--case">
          <div className="hx-float">
            <TraceConsole />
          </div>
        </div>
        <div className="hx-layer hx-layer--pin" aria-hidden="true">
          <div className="hx-float hx-card hx-pin">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" focusable="false">
              <path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 1 0-9 0c0 3.8 4.5 8 4.5 8Z" />
              <circle cx="8" cy="6.5" r="1.6" />
            </svg>
            <span>
              <strong>{pin.label}</strong>
              <small>{pin.meta}</small>
            </span>
          </div>
        </div>
        <div className="hx-layer hx-layer--board" aria-hidden="true">
          <div className="hx-float hx-card hx-lb">
            <p className="hx-card__head">
              <span>{leaderboard.title}</span>
              <span className="hx-card__meta">{leaderboard.meta}</span>
            </p>
            <ol className="hx-lb__rows">
              {leaderboard.rows.map((row, index) => (
                <li key={row.handle} className={index === 0 ? "is-top" : undefined}>
                  <span className="hx-lb__pos">{String(index + 1).padStart(2, "0")}</span>
                  <span className="hx-lb__who">
                    <span className="hx-lb__handle">{row.handle}</span>
                    <span className="hx-lb__rank">{row.rank}</span>
                  </span>
                  <span className="hx-lb__xp">
                    {row.xp}
                    <small> {leaderboard.xpLabel}</small>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="hx-layer hx-layer--cert" aria-hidden="true">
          <div className="hx-float hx-card hx-cert">
            <svg className="hx-cert__qr" viewBox="-1 -1 19 19" focusable="false">
              <path d={QR_PATH} />
            </svg>
            <span className="hx-cert__text">
              <span className="hx-card__meta">{certificate.title}</span>
              <strong>{certificate.course}</strong>
              <span className="hx-cert__id">{certificate.id}</span>
              <span className="hx-cert__ok">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" focusable="false">
                  <path d="M6.5 11.2 3.3 8l-.7.7 3.9 3.9 7-7-.7-.7z" />
                </svg>
                {certificate.verified}
              </span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

const TRACK_ICONS = {
  osint: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5M11 7.5v7M7.5 11h7" />
    </svg>
  ),
  web_pentesting: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7 10 3 2.5L7 15M12.5 15H17" />
    </svg>
  ),
};

/**
 * The two course categories, inside the hero: OSINT (live now, to its
 * courses) and Pentesting (browsable; "Coming soon" until the server's
 * purchase gate opens).
 */
export function HeroTracks({ gate }) {
  const pentestingOpen = Boolean(gate?.enabled);
  const tiles = [
    { ...HP_HERO_TRACKS.osint, key: "osint", to: getCourseCategoryPath("osint"), status: HP_HERO_TRACKS.osint.status, live: true },
    {
      ...HP_HERO_TRACKS.pentesting,
      key: "web_pentesting",
      to: "/tracks/pentesting",
      status: pentestingOpen ? HP_HERO_TRACKS.pentesting.statusOpen : HP_HERO_TRACKS.pentesting.status,
      live: pentestingOpen,
    },
  ];
  return (
    <ul className="hp-hero__tracks" aria-label={HP_HERO_TRACKS.label}>
      {tiles.map((tile) => (
        <li key={tile.key} data-track={tile.key} data-state={tile.live ? "open" : "coming_soon"}>
          <RouterLink to={tile.to} className="hp-htrack">
            <span className="hp-htrack__icon">{TRACK_ICONS[tile.key]}</span>
            <span className="hp-htrack__status">
              {tile.live ? <span className="hp-htrack__dot" aria-hidden="true" /> : null}
              {tile.status}
            </span>
            <span className="hp-htrack__kind">{tile.kind}</span>
            <span className="hp-htrack__title">{tile.title}</span>
            <span className="hp-htrack__desc">{tile.description}</span>
            <span className="hp-htrack__fact">{tile.fact}</span>
            <svg className="hp-htrack__arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
              <path d="M3 8h10M9 4l4 4-4 4" />
            </svg>
          </RouterLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hero: live schedule badge, a big headline with one accent-gradient line,
 * the actions and the investigation board; below them a dock with the two
 * categories and the real figures. `siteStats` overrides the fetched figures
 * (tests, previews). The figures render as final values (a count-up above
 * the fold would sit at "0" until scrolled); while they load, a same-size
 * placeholder holds their place so nothing below moves.
 */
export function LandingHero({ isAuthenticated, liveBroadcast, siteStats, gate }) {
  const live = useSiteStats();
  const override = Array.isArray(siteStats);
  const rows = heroStatItems(override ? siteStats : live.items);
  const loading = !override && live.status === "loading";
  const last = HP_HERO.headline.length - 1;
  return (
    <section className="hp-hero hp-hero--signal" aria-labelledby="hp-home-title">
      <div className="hx-bg" aria-hidden="true">
        <span className="hx-bg__glow hx-bg__glow--a" />
        <span className="hx-bg__glow hx-bg__glow--b" />
        <span className="hx-bg__glow hx-bg__glow--c" />
        <span className="hx-bg__grid" />
        <span className="hx-bg__noise" />
      </div>
      <div className="hx-top">
        <div className="hx-copy">
          <p className="hp-hero__badge">
            <span className="hp-hero__badge-live">
              <span className="hp-hero__badge-dot" aria-hidden="true" />
              {HP_HERO.badgeLive}
            </span>
            <span>{HP_HERO.badgeSchedule}</span>
          </p>
          <h1 id="hp-home-title" className="hp-display hx-title">
            {HP_HERO.headline.map((line, index) => (
              <span key={line} className={`hx-title__line${index === last ? " hx-title__line--accent" : ""}`}>
                {line}{" "}
              </span>
            ))}
          </h1>
          <p className="hp-lead hx-lead">{HP_HERO.sub}</p>
          {liveBroadcast ? (
            <p className="hp-hero__note" role="status">
              <StatusPill kind="live">{HP_HERO.liveLabel}</StatusPill>
              <span>{liveBroadcast.title || HP_HERO.liveFallback}</span>
              <ButtonLink to={isAuthenticated ? liveBroadcastJoinPath(liveBroadcast) : "/login"} variant="ghost" size="sm" arrow>
                {HP_HERO.liveCta}
              </ButtonLink>
            </p>
          ) : null}
          <div className="hp-actions hx-actions">
            <ButtonLink to={FREE_TIER.href} variant="primary" size="lg" arrow className="hx-cta">
              {HP_HERO.primaryCta}
            </ButtonLink>
            <ButtonLink to="/courses" variant="secondary" size="lg" className="hx-cta-2">
              {HP_HERO.secondaryCta}
            </ButtonLink>
          </div>
        </div>
        <InvestigationBoard />
      </div>
      <div className="hx-dock">
        <HeroTracks gate={gate} />
        <div className="hx-dock__stats">
          {rows.length ? (
            <StatStrip items={rows.map(({ label, value }) => ({ label, value }))} label={HP_HERO.statsLabel} className="hp-hero__stats" />
          ) : loading ? (
            <div className="hx-skel" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Two tracks in one hairline frame (inversion hover). Pentesting is browsable and says "Coming soon". */
export function TrackPair({ gate }) {
  const pentestingOpen = gate.enabled;
  return (
    <section className="hp-band hp-band--tight-top" aria-labelledby="hp-tracks-title">
      <div className="hp-frame">
        <h2 id="hp-tracks-title" className="hp-sr">
          {HP_TRACKS.heading}
        </h2>
        <ul className="hp-grid" aria-label={HP_TRACKS.heading}>
          <li data-track="osint" data-state="open">
            <CardShell
              className="hp-feature"
              href="/tracks/osint"
              title={HP_TRACKS.osint.title}
              label={`${HP_TRACKS.osint.title} track. Open`}
              eyebrow={HP_TRACKS.osint.eyebrow}
              status={<StatusPill kind="open">Open</StatusPill>}
              art="magnifier"
              description={HP_TRACKS.osint.description}
              facts={HP_TRACKS.osint.facts}
              action={HP_TRACKS.osint.action}
            />
          </li>
          <li data-track="web_pentesting" data-state={pentestingOpen ? "open" : "coming_soon"}>
            <CardShell
              className="hp-feature"
              href="/tracks/pentesting"
              title={HP_TRACKS.pentesting.title}
              label={`${HP_TRACKS.pentesting.title} track. ${pentestingOpen ? "Open" : "Coming soon: browse every course now"}`}
              eyebrow={HP_TRACKS.pentesting.eyebrow}
              status={pentestingOpen ? <StatusPill kind="open">Open</StatusPill> : <StatusPill kind="soon">Coming soon</StatusPill>}
              art="foundations"
              description={HP_TRACKS.pentesting.description}
              facts={pentestingOpen ? HP_TRACKS.pentesting.factsOpen : HP_TRACKS.pentesting.factsSoon}
              action={HP_TRACKS.pentesting.action}
            />
          </li>
        </ul>
      </div>
    </section>
  );
}

function OpenNow({ catalog: feed, liveClasses, liveBroadcast }) {
  // "Open now" lists the programmes you can join; Pentesting courses (browsable,
  // not yet on sale) live on their track page and in the catalogue tiers.
  const catalog = { ...feed, courses: feed.courses.filter((course) => course?.category !== "web_pentesting") };
  return (
    <section className="hp-band hp-rule-top" aria-labelledby="hp-open-title" id="programs">
      <div className="hp-frame">
        <div className="hp-section-head hp-section-head--split">
          <div className="hp-section-head__copy">
            <Eyebrow>{HP_OPEN_NOW.eyebrow}</Eyebrow>
            <h2 id="hp-open-title" className="hp-h2">
              {HP_OPEN_NOW.lead} <Hand>{HP_OPEN_NOW.accent}</Hand>
            </h2>
            <p className="hp-lead">{HP_OPEN_NOW.body}</p>
          </div>
          <ButtonLink to="/courses" variant="secondary" size="sm" arrow>
            {HP_OPEN_NOW.cta}
          </ButtonLink>
        </div>
        <div className="hp-after-head lp-hp-open">
          <HeroCountdownStrip courses={catalog.courses} />
          <BestsellersContent catalog={catalog} browsableTracks />
        </div>
      </div>
      <LiveClassesBand theme="g100" liveClasses={liveClasses} liveBroadcast={liveBroadcast} />
    </section>
  );
}

// Copy from landingContent.js (HP_STORY); each step keeps its product mock.
const STORY_MOCKS = [<TrackPickerMock key="track" />, <PlayerMock key="player" />, <ReportMock key="report" />, <TerminalMock key="lab" />, <ExamMock key="exam" />, <CertificateMock key="cert" />];
const STORY_STEPS = HP_STORY.steps.map((step, index) => ({ ...step, ui: STORY_MOCKS[index] }));

export const STORY_PRINCIPLES = HP_STORY.principles;

export function StoryBand() {
  return (
    <section className="hp-band hp-band--lg hp-rule-top" aria-labelledby="hp-story-title">
      <div className="hp-frame">
        <div className="hp-stack-center">
          <DisplayHeading id="hp-story-title" lines={HP_STORY.lines} periods />
          <p className="hp-lead" style={{ marginTop: 24 }}>
            {HP_STORY.lead}
          </p>
        </div>
        <div className="hp-story hp-after-head">
          <div className="hp-story__aside">
            <Eyebrow>{HP_STORY.asideEyebrow}</Eyebrow>
            <h3 className="hp-h3">{HP_STORY.asideTitle}</h3>
            <p className="hp-body">{HP_STORY.asideBody}</p>
            <CheckList items={STORY_PRINCIPLES} />
          </div>
          <ol className="hp-tl">
            {STORY_STEPS.map((step, index) => (
              <li key={step.title} className="hp-tl__step">
                <span className="hp-tl__dot" aria-hidden="true" />
                <p className="hp-eyebrow">{step.kicker}</p>
                <h3 className="hp-tl__heading">
                  <span className="hp-tl__num" aria-hidden="true">
                    {index + 1}.
                  </span>
                  <span className="hp-tl__title">{step.title}</span>
                </h3>
                <p className="hp-tl__sub">{step.sub}</p>
                <div className="hp-tl__ui">{step.ui}</div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------- batches, packages, rewards */

/**
 * The open OSINT batch from the course list the landing already loads: an
 * OSINT course still taking registrations, the latest start date first.
 * Title, start date and fee are read from the course, never hard-coded.
 */
export function selectOpenBatch(courses = []) {
  const open = (Array.isArray(courses) ? courses : []).filter(
    (course) => course?.category === "osint" && !course.registration_closed && course.launch_status !== "coming_soon"
  );
  open.sort((a, b) => String(b.start_date || "").localeCompare(String(a.start_date || "")));
  return open[0] || null;
}

function courseFee(course) {
  const amount = Number(course?.price);
  return Number.isFinite(amount) && amount > 0 ? rupees(amount) : "";
}

function formatStart(value) {
  if (!value) return "";
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function SectionIntro({ id, content }) {
  return (
    <div className="hp-section-head">
      <div className="hp-section-head__copy">
        <Eyebrow>{content.eyebrow}</Eyebrow>
        <h2 id={id} className="hp-h2">
          {content.lead} <Hand>{content.accent}</Hand>
        </h2>
        <p className="hp-lead">{content.body}</p>
      </div>
    </div>
  );
}

export function BatchesBand({ courses = [] }) {
  const batch = selectOpenBatch(courses);
  const fee = courseFee(batch);
  const start = formatStart(batch?.start_date);
  return (
    <section className="hp-band hp-rule-top" aria-labelledby="hp-batches-title" id="batches">
      <div className="hp-frame">
        <SectionIntro id="hp-batches-title" content={HP_BATCHES} />
        <div className="hp-after-head hp-lp-split">
          <ol className="hp-lp-steps">
            {HP_BATCHES.steps.map((step, index) => (
              <li key={step.title}>
                <span className="hp-lp-steps__num" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="hp-lp-steps__title">{step.title}</span>
                <span className="hp-lp-steps__text">{step.text}</span>
              </li>
            ))}
          </ol>
          <div className="hp-lp-batch">
            {batch ? (
              <article className="hp-lp-panel" aria-label={HP_BATCHES.openLabel} data-course-id={batch.id}>
                <StatusPill kind="open">{HP_BATCHES.openLabel}</StatusPill>
                <h3 className="hp-lp-panel__title">{batch.card_title || batch.title || HP_BATCHES.openTitleFallback}</h3>
                <dl className="hp-lp-facts">
                  {start ? (
                    <div>
                      <dt>{HP_BATCHES.startsLabel}</dt>
                      <dd>{start}</dd>
                    </div>
                  ) : null}
                  {fee ? (
                    <div>
                      <dt>{HP_BATCHES.feeLabel}</dt>
                      <dd>{fee}</dd>
                    </div>
                  ) : null}
                </dl>
                <ButtonLink to={`/courses/${batch.id}`} variant="primary" size="sm" arrow>
                  {HP_BATCHES.openCta}
                </ButtonLink>
              </article>
            ) : (
              <article className="hp-lp-panel">
                <p className="hp-body">{HP_BATCHES.noOpen}</p>
                <ButtonLink to="/courses" variant="secondary" size="sm" arrow>
                  {HP_BATCHES.noOpenCta}
                </ButtonLink>
              </article>
            )}
            <div className="hp-lp-past">
              <p className="hp-eyebrow">{HP_BATCHES.pastLabel}</p>
              <ul>
                {HP_BATCHES.past.map((item) => (
                  <li key={item.name}>
                    <span>{item.name}</span>
                    <span className="hp-lp-past__status">
                      <CheckIcon />
                      {item.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CompareCell({ value }) {
  if (value === true) {
    return (
      <span className="hp-table__yes">
        <CheckIcon />
        <span className="hp-sr">Included</span>
      </span>
    );
  }
  if (!value) {
    return (
      <span className="hp-table__no">
        <span aria-hidden="true">—</span>
        <span className="hp-sr">Not included</span>
      </span>
    );
  }
  return <span>{value}</span>;
}

function PackageCard({ title, price, period, badge, status, features, cta, to, highlighted = false }) {
  return (
    <li className={`hp-lp-pkg${highlighted ? " is-highlighted" : ""}`}>
      <div className="hp-lp-pkg__top">
        <h3 className="hp-lp-pkg__title">{title}</h3>
        {badge ? <span className="hp-lp-pkg__badge">{badge}</span> : null}
        {status ? <StatusPill kind="soon">{status}</StatusPill> : null}
      </div>
      {price ? (
        <p className="hp-lp-pkg__price">
          <span>{price}</span> {period ? <span className="hp-lp-pkg__period">{period}</span> : null}
        </p>
      ) : null}
      <ul className="hp-lp-pkg__list">
        {features.map((feature) => (
          <li key={feature}>
            <CheckIcon />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <ButtonLink to={to} variant={highlighted ? "primary" : "secondary"} size="sm" arrow className="hp-lp-pkg__cta">
        {cta}
      </ButtonLink>
    </li>
  );
}

/** A server price wins over the stated monthly price. */
function packagePrice(plans, key, fallback) {
  const plan = plans.find((item) => item.key === key);
  return planPriceLabel(plan) || rupees(fallback);
}

export function PackagesBand({ courses = [], plans }) {
  const merged = mergePlans(OSINT_PLANS, plans);
  const batch = selectOpenBatch(courses);
  const cohortFee = courseFee(batch);
  const P = HP_PACKAGES;
  return (
    <section className="hp-band hp-rule-top" aria-labelledby="hp-packages-title" id="packages">
      <div className="hp-frame">
        <SectionIntro id="hp-packages-title" content={P} />
        <div className="hp-after-head">
          <ul className="hp-lp-pkgs" aria-label={P.eyebrow}>
            <PackageCard {...P.free} price={rupees(0)} to={FREE_TIER.href} />
            <PackageCard {...P.starter} price={packagePrice(merged, "starter", P.starter.price)} to="/pricing#osint" />
            <PackageCard {...P.ctf_labs} price={packagePrice(merged, "ctf_labs", P.ctf_labs.price)} to="/pricing#osint" highlighted />
            <PackageCard
              {...P.cohort}
              price={cohortFee || P.cohort.noPrice}
              period={cohortFee ? P.cohort.period : ""}
              to={batch ? `/courses/${batch.id}` : getCourseCategoryPath("osint")}
            />
            <PackageCard {...P.pentesting} to="/tracks/pentesting" />
          </ul>
        </div>
        <div className="hp-table-wrap hp-lp-compare">
          <table className="hp-table">
            <caption className="hp-sr">{P.compareTitle}</caption>
            <thead>
              <tr>
                <th scope="col">{P.compareTitle}</th>
                {P.compareColumns.map((column) => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {P.compareRows.map((row) => (
                <tr key={row.feature}>
                  <th scope="row">{row.feature}</th>
                  {row.values.map((value, index) => (
                    <td key={P.compareColumns[index]}>
                      <CompareCell value={value} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hp-actions hp-lp-actions">
          <ButtonLink to="/pricing" variant="secondary" size="sm" arrow>
            {P.pricingCta}
          </ButtonLink>
          <ButtonLink to="/roadmap" variant="ghost" size="sm" arrow>
            {P.roadmapCta}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

const MOCK_BOARD = [
  { place: 1, handle: "@shadowtrace", xp: 1240 },
  { place: 2, handle: "@geo_hound", xp: 1105, you: true },
  { place: 3, handle: "@pivotpoint", xp: 980 },
];

/** Code-built mocks: a rank chip, a segmented XP meter and a leaderboard row. */
export function RewardsMock() {
  const current = LEVELS[2];
  const next = LEVELS[3];
  const xp = 4800;
  const segments = 10;
  const filled = Math.round(((xp - current.min_xp) / (next.min_xp - current.min_xp)) * segments);
  return (
    <figure className="hp-lp-rmock" aria-label="Example: a student's rank, XP and leaderboard row">
      <p className="hp-eyebrow">{HP_REWARDS.mockRankLabel}</p>
      <div className="hp-lp-rank">
        <span className="hp-lp-rank__pip" aria-hidden="true">
          {current.number}
        </span>
        <span className="hp-lp-rank__name">{current.title}</span>
        <span className="hp-lp-rank__xp">{xp.toLocaleString("en-IN")} XP</span>
      </div>
      <div className="hp-lp-meter" role="img" aria-label={`${filled} of ${segments} segments to ${next.title}`}>
        {Array.from({ length: segments }, (_, index) => (
          <span key={index} className={index < filled ? "is-on" : undefined} />
        ))}
      </div>
      <p className="hp-lp-meter__caption">
        {(next.min_xp - xp).toLocaleString("en-IN")} XP to {next.title}
      </p>
      <p className="hp-eyebrow hp-lp-rmock__label">{HP_REWARDS.mockLeaderboardLabel}</p>
      <ol className="hp-lp-board">
        {MOCK_BOARD.map((row) => (
          <li key={row.handle} className={row.you ? "is-you" : undefined}>
            <span className="hp-lp-board__place">#{row.place}</span>
            <span className="hp-lp-board__handle">{row.handle}</span>
            <span className="hp-lp-board__xp">{row.xp.toLocaleString("en-IN")} XP</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

export function RewardsBand() {
  const R = HP_REWARDS;
  return (
    <section className="hp-band hp-rule-top" aria-labelledby="hp-rewards-title" id="rewards">
      <div className="hp-frame">
        <SectionIntro id="hp-rewards-title" content={R} />
        <div className="hp-after-head hp-lp-split">
          <div>
            <h3 className="hp-lp-subhead">{R.xpTitle}</h3>
            <dl className="hp-lp-xp">
              {R.xp.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>
                    <span className="hp-lp-xp__value">{item.value}</span>
                    <span className="hp-lp-xp__note">{item.note}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <h3 className="hp-lp-subhead">{R.prizesTitle}</h3>
            <ul className="hp-lp-prizes">
              {R.prizes.map((prize) => (
                <li key={prize.place}>
                  <span className="hp-lp-prizes__place">{prize.place}</span>
                  <span>{prize.xp}</span>
                </li>
              ))}
            </ul>
          </div>
          <RewardsMock />
        </div>
        <h3 className="hp-lp-subhead">{R.ranksTitle}</h3>
        <ol className="hp-lp-ranks" aria-label={R.ranksTitle}>
          {LEVELS.map((level) => (
            <li key={level.key}>
              <span className="hp-lp-ranks__num" aria-hidden="true">
                {level.number}
              </span>
              <span className="hp-lp-ranks__name">{level.title}</span>
              <span className="hp-lp-ranks__xp">{level.min_xp.toLocaleString("en-IN")} XP</span>
            </li>
          ))}
        </ol>
        <div className="hp-lp-extras">
          <CheckList items={R.extras} />
          <div className="hp-actions">
            <ButtonLink to="/hall-of-fame" variant="secondary" size="sm" arrow>
              {R.hallCta}
            </ButtonLink>
            <ButtonLink to="/certificates" variant="ghost" size="sm" arrow>
              {R.verifyCta}
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

export function NeverAloneBand() {
  return (
    <section id="about" className="hp-band hp-band--lg hp-rule-top" aria-labelledby="hp-about-title">
      <div className="hp-frame">
        <div className="hp-story">
          <div>
            <Eyebrow>
              {HP_COMMUNITY.eyebrowPrefix} {siteBrand.name}
            </Eyebrow>
            <h2 id="hp-about-title" className="hp-h2" style={{ marginTop: 12 }}>
              {HP_COMMUNITY.lead} <Hand>{HP_COMMUNITY.accent}</Hand>
            </h2>
            <p className="hp-lead" style={{ marginTop: 20 }}>
              {HP_COMMUNITY.body}
            </p>
            <div className="hp-actions" style={{ marginTop: 32 }}>
              <ButtonLink to="/about" variant="secondary" arrow>
                {HP_COMMUNITY.aboutCta}
              </ButtonLink>
              <ButtonLink to="/hall-of-fame" variant="ghost" arrow>
                {HP_COMMUNITY.hallCta}
              </ButtonLink>
            </div>
          </div>
          <ClassroomMock />
        </div>
        <SiteStatStrip wide className="lp-stats hp-after-head" label={HP_COMMUNITY.statsLabel} />
      </div>
    </section>
  );
}

/** The landing page. Header and footer come from the layout. */
export default function LandingPageHP() {
  const { isAuthenticated } = useAuth();
  const { courses: catalog, gate, catalog: publicCatalog } = useMarketingData();
  const liveClasses = useLandingLiveClasses(isAuthenticated);
  const liveBroadcast = useHeroLiveBroadcast(isAuthenticated);
  const youtube = useYouTubeChannel();
  const showWatch = watchBandVisible(youtube);
  // /#about and /#contact deep links, once the data bands above them settled.
  useHashScroll(["about", "contact"], catalog.status !== "loading" && liveClasses.status !== "loading");

  return (
    <div className="lp lp--hp" data-brand={siteBrand.id}>
      <LandingHero isAuthenticated={isAuthenticated} liveBroadcast={liveBroadcast} gate={gate} />
      <BatchesBand courses={catalog.courses} />
      <PackagesBand courses={catalog.courses} plans={publicCatalog.plans} />
      <RewardsBand />
      <OpenNow catalog={catalog} liveClasses={liveClasses} liveBroadcast={liveBroadcast} />
      <StoryBand />
      <NeverAloneBand />
      {showWatch ? <WatchBand theme="g100" youtube={youtube} /> : null}
    </div>
  );
}
