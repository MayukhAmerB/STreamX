// The public landing page in the HackPath philosophy (PHILOSOPHY T1/T2/T5,
// BUILD_PLAN §2.1 "/"): black canvas, an investigation-console hero (headline,
// an OSINT pivot chain in a terminal panel, the live site figures), real product UI in a numbered
// timeline, the open programmes and live classes (same data and states as
// before), the Watch band, the pricing band and the footer wordmark (layout).
import { Link as RouterLink } from "react-router-dom";

import { siteBrand } from "../../config/siteBrand";
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
import PricingBand from "../../marketing/PricingBand";
import {
  ButtonLink,
  CheckList,
  DisplayHeading,
  Eyebrow,
  Hand,
  StatStrip,
  StatusPill,
} from "../../marketing/primitives";
import SiteStatStrip, { siteStatValues } from "../../marketing/SiteStatStrip";
import { useSiteStats } from "../../marketing/siteStats";
import { useMarketingData } from "../../marketing/useMarketingData";
import { FREE_TIER } from "../../data/freeLabs";
import { getCourseCategoryPath } from "../../utils/courseCatalog";
import { BestsellersContent } from "./BestsellersBand";
import { HeroCountdownStrip } from "./HeroBand";
import {
  HP_COMMUNITY,
  HP_HERO_TRACE,
  HP_HERO_TRACKS,
  HP_HERO,
  HP_OPEN_NOW,
  HP_PRACTISE,
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

/** The terminal panel: one OSINT case, pivot by pivot, ending in "case closed". */
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
            <span className={`hp-htrack__status${tile.live ? " is-live" : ""}`}>
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
 * Hero: live schedule badge, headline, actions and the real figures, with the
 * trace console beside it (desktop) or below it (phone). `siteStats` overrides
 * the fetched figures (tests, previews).
 */
export function LandingHero({ isAuthenticated, liveBroadcast, siteStats, gate }) {
  const live = useSiteStats();
  const rows = heroStatItems(Array.isArray(siteStats) ? siteStats : live.items);
  return (
    <section className="hp-hero hp-hero--console" aria-labelledby="hp-home-title">
      <div className="hp-hero__grid">
        <div className="hp-hero__copy">
          <p className="hp-hero__badge">
            <span className="hp-hero__badge-live">
              <span className="hp-hero__badge-dot" aria-hidden="true" />
              {HP_HERO.badgeLive}
            </span>
            <span>{HP_HERO.badgeSchedule}</span>
          </p>
          <h1 id="hp-home-title" className="hp-display hp-display--hero hp-hero__title">
            {HP_HERO.headline.map((line, index) => (
              <span key={line} className={`hp-hero__line${index === HP_HERO.headline.length - 1 ? " hp-hero__line--strong" : ""}`}>
                {line}{" "}
              </span>
            ))}
          </h1>
          <p className="hp-lead hp-hero__lead">{HP_HERO.sub}</p>
          {liveBroadcast ? (
            <p className="hp-hero__note" role="status">
              <StatusPill kind="live">{HP_HERO.liveLabel}</StatusPill>
              <span>{liveBroadcast.title || HP_HERO.liveFallback}</span>
              <ButtonLink to={isAuthenticated ? liveBroadcastJoinPath(liveBroadcast) : "/login"} variant="ghost" size="sm" arrow>
                {HP_HERO.liveCta}
              </ButtonLink>
            </p>
          ) : null}
          <div className="hp-actions hp-hero__actions">
            <ButtonLink to={FREE_TIER.href} variant="primary" size="lg" arrow>
              {HP_HERO.primaryCta}
            </ButtonLink>
            <ButtonLink to="/courses" variant="secondary" size="lg">
              {HP_HERO.secondaryCta}
            </ButtonLink>
          </div>
          <HeroTracks gate={gate} />
          {rows.length ? <StatStrip items={siteStatValues(rows)} label={HP_HERO.statsLabel} className="hp-hero__stats" /> : null}
        </div>
        <div className="hp-hero__panel">
          <TraceConsole />
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

export function PractiseBand() {
  return (
    <section className="hp-band hp-band--lg hp-rule-top" aria-labelledby="hp-practise-title">
      <div className="hp-frame">
        <div className="hp-stack-center">
          <DisplayHeading id="hp-practise-title" lines={HP_PRACTISE.lines} periods />
          <p className="hp-lead" style={{ marginTop: 24 }}>
            {HP_PRACTISE.lead}
          </p>
        </div>
        <div className="hp-after-head" style={{ maxWidth: 56 + "rem", marginInline: "auto" }}>
          <TerminalMock title={HP_PRACTISE.terminalTitle} lines={HP_PRACTISE.terminal} />
        </div>
        <ul className="hp-cols">
          <li>
            <h3>{HP_PRACTISE.columns.free.title}</h3>
            <p>{HP_PRACTISE.columns.free.body}</p>
            <p>
              <ButtonLink to={FREE_TIER.href} variant="ghost" size="sm" arrow>
                {HP_PRACTISE.columns.free.cta}
              </ButtonLink>
            </p>
          </li>
          <li>
            <h3>{HP_PRACTISE.columns.labs.title}</h3>
            <p>{HP_PRACTISE.columns.labs.body}</p>
            <p>
              <ButtonLink to="/pricing" variant="ghost" size="sm" arrow>
                {HP_PRACTISE.columns.labs.cta}
              </ButtonLink>
            </p>
          </li>
          <li>
            <h3>{HP_PRACTISE.columns.roadmap.title}</h3>
            <p>{HP_PRACTISE.columns.roadmap.body}</p>
            <p>
              <ButtonLink to="/roadmap" variant="ghost" size="sm" arrow>
                {HP_PRACTISE.columns.roadmap.cta}
              </ButtonLink>
            </p>
          </li>
        </ul>
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
  const { courses: catalog, gate } = useMarketingData();
  const liveClasses = useLandingLiveClasses(isAuthenticated);
  const liveBroadcast = useHeroLiveBroadcast(isAuthenticated);
  const youtube = useYouTubeChannel();
  const showWatch = watchBandVisible(youtube);
  // /#about and /#contact deep links, once the data bands above them settled.
  useHashScroll(["about", "contact"], catalog.status !== "loading" && liveClasses.status !== "loading");

  return (
    <div className="lp lp--hp" data-brand={siteBrand.id}>
      <LandingHero isAuthenticated={isAuthenticated} liveBroadcast={liveBroadcast} gate={gate} />
      <OpenNow catalog={catalog} liveClasses={liveClasses} liveBroadcast={liveBroadcast} />
      <StoryBand />
      <PractiseBand />
      <NeverAloneBand />
      {showWatch ? <WatchBand theme="g100" youtube={youtube} /> : null}
      <PricingBand />
    </div>
  );
}
