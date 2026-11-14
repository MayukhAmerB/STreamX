// The public landing page in the HackPath philosophy (PHILOSOPHY T1/T2/T5,
// BUILD_PLAN §2.1 "/"): black canvas, the golden Qur'an 20:114 calligraphy as
// the hero, one handwritten accent per headline, real product UI in a numbered
// timeline, the open programmes and live classes (same data and states as
// before), the Watch band, the pricing band and the footer wordmark (layout).
import { siteBrand } from "../../config/siteBrand";
import { useYouTubeChannel } from "../../features/youtube/youTubeStore";
import { useAuth } from "../../hooks/useAuth";
import heroStacked from "../../assets/brand/hero-quran-20-114-stacked.svg";
import heroWide from "../../assets/brand/hero-quran-20-114.svg";
import heroMeta from "../../assets/brand/hero-quran-20-114.meta.json";
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
  Tagline,
} from "../../marketing/primitives";
import SiteStatStrip from "../../marketing/SiteStatStrip";
import { useMarketingData } from "../../marketing/useMarketingData";
import { FREE_TIER } from "../../data/freeLabs";
import { BestsellersContent } from "./BestsellersBand";
import { HeroCountdownStrip } from "./HeroBand";
import {
  HERO_REFERENCE,
  HERO_TAGLINE,
  HERO_TRANSLATION,
  HP_COMMUNITY,
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

// Copy lives in landingContent.js; re-exported for the existing imports and tests.
export { HERO_REFERENCE, HERO_TAGLINE, HERO_TRANSLATION };

/** The calligraphy (wide ≥ 641 px, stacked below), with a same-ratio slot if the art is missing. */
export function Calligraphy({ wide = heroWide, stacked = heroStacked, alt = heroMeta?.alt }) {
  if (!wide) {
    return (
      <span className="hp-calligraphy" role="img" aria-label={alt || HERO_REFERENCE}>
        <span className="hp-calligraphy__slot" />
      </span>
    );
  }
  return (
    <picture className="hp-calligraphy">
      {stacked ? <source media="(max-width: 640px)" srcSet={stacked} width="760" height="800" /> : null}
      <img src={wide} alt={alt || `${HERO_REFERENCE}: ${HERO_TRANSLATION}`} width="1500" height="500" fetchpriority="high" decoding="async" />
    </picture>
  );
}

export function LandingHero({ isAuthenticated, liveBroadcast, stats }) {
  const strip = [
    { label: "Courses", value: stats.courses || null },
    { label: "Modules", value: stats.modules || null },
    { label: "Free challenges", value: stats.freeChallenges || "Free" },
    { label: "Live cohorts", value: stats.liveCohorts || null },
  ];
  return (
    <section className="hp-hero" aria-labelledby="hp-home-title">
      <Tagline>{HERO_TAGLINE}</Tagline>
      <Calligraphy />
      <figure className="hp-verse">
        <blockquote className="hp-verse__translation">
          <p>{HERO_TRANSLATION}</p>
        </blockquote>
        <figcaption>
          <cite className="hp-kicker hp-verse__ref">{HERO_REFERENCE}</cite>
        </figcaption>
      </figure>
      <h1 id="hp-home-title" className="hp-display hp-display--hero hp-hero__title">
        <span className="hp-display__line">{HP_HERO.lead}</span> <span className="hp-display__line"><Hand accent>{HP_HERO.accent}</Hand>.</span>
      </h1>
      <p className="hp-lead">{HP_HERO.sub}</p>
      {liveBroadcast ? (
        <p className="hp-hero__note" role="status">
          <StatusPill kind="live">{HP_HERO.liveLabel}</StatusPill>
          <span>{liveBroadcast.title || HP_HERO.liveFallback}</span>
          <ButtonLink to={isAuthenticated ? liveBroadcastJoinPath(liveBroadcast) : "/login"} variant="ghost" size="sm" arrow>
            {HP_HERO.liveCta}
          </ButtonLink>
        </p>
      ) : null}
      <div className="hp-actions">
        <ButtonLink to={FREE_TIER.href} variant="primary" size="lg" arrow>
          {HP_HERO.primaryCta}
        </ButtonLink>
        <ButtonLink to="/courses" variant="secondary" size="lg">
          {HP_HERO.secondaryCta}
        </ButtonLink>
      </div>
      <StatStrip items={strip} label={HP_HERO.statsLabel} />
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
  const { courses: catalog, gate, stats } = useMarketingData();
  const liveClasses = useLandingLiveClasses(isAuthenticated);
  const liveBroadcast = useHeroLiveBroadcast(isAuthenticated);
  const youtube = useYouTubeChannel();
  const showWatch = watchBandVisible(youtube);
  // /#about and /#contact deep links, once the data bands above them settled.
  useHashScroll(["about", "contact"], catalog.status !== "loading" && liveClasses.status !== "loading");

  return (
    <div className="lp lp--hp" data-brand={siteBrand.id}>
      <LandingHero isAuthenticated={isAuthenticated} liveBroadcast={liveBroadcast} stats={stats} />
      <TrackPair gate={gate} />
      <OpenNow catalog={catalog} liveClasses={liveClasses} liveBroadcast={liveBroadcast} />
      <StoryBand />
      <PractiseBand />
      <NeverAloneBand />
      {showWatch ? <WatchBand theme="g100" youtube={youtube} /> : null}
      <PricingBand />
    </div>
  );
}
