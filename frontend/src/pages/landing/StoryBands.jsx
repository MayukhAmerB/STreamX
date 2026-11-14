import certificateExcellenceImage from "../../assets/certificate-excellence.webp";
import storyIllustration from "../../assets/story-mission.webp";
import { journeyBlocks, owlCognitoJourneyBlocks } from "../../components/StoryJourneySection";
import { siteBrand } from "../../config/siteBrand";
import { Band, Button, Column, DataStat, ProgressIndicator, Reveal, Tag, Tile } from "../../site-kit";
import { siteStatValues } from "../../marketing/SiteStatStrip";
import { useSiteStats } from "../../marketing/siteStats";
import { CountUp } from "../../site-kit/motion";
import { ArrowRight, BandHeading, WhyIcon } from "./LandingParts";
import {
  ABOUT_SUBTITLE,
  ABOUT_TITLE,
  CTA_BODY,
  CTA_TITLE,
  INFO_CARDS,
  JOURNEY_STEPS,
  JOURNEY_SUBTITLE,
  JOURNEY_TITLE,
  WHY_CHOOSE,
  WHY_SUBTITLE,
  WHY_TITLE,
} from "./landingContent";

const CERTIFICATE_FACTS = [
  ["Recipient", "Personalized student name"],
  ["Recognition", "Training achievement"],
  ["Authorization", "Official signature and issue date"],
];

/** Band 5: the certificate as a document (copy cols 1-6, image cols 7-16; side by side from md, so tablets do not stack a tall dark band). */
export function CertificateBand({ theme = "g100" }) {
  return (
    <Band theme={theme} className="lp-band lp-cert" labelledBy="lp-cert-title">
      <Column sm={4} md={4} lg={6} className="lp-cert__copy">
        <Tag size="sm">Certificate format</Tag>
        <h2 id="lp-cert-title" className="lp-h2">
          Recognition designed to carry forward
        </h2>
        <p className="lp-lead">
          Successful learners receive an official Certificate of Excellence in this official format, recording the recipient,
          completion date, and authorized recognition of their training achievement.
        </p>
        <dl className="lp-facts">
          {CERTIFICATE_FACTS.map(([label, value]) => (
            <div key={label} className="lp-facts__row">
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Column>
      <Column sm={4} md={4} lg={10}>
        <Reveal as="figure" className="lp-cert__figure">
          <span className="lp-cert__frame">
            <img
              src={certificateExcellenceImage}
              alt={`${siteBrand.name} Certificate of Excellence format`}
              width="1600"
              height="900"
              loading="lazy"
              decoding="async"
            />
          </span>
          <figcaption className="lp-cert__caption">Official certificate format presented to successful learners.</figcaption>
        </Reveal>
      </Column>
    </Band>
  );
}

const COUNTABLE = /^(\d+)([+%x]?)$/;

/**
 * The key figures with a count-up (M5, first view per session, from 50 %
 * visible; the shared CountUp shows the final value under reduced motion and
 * to assistive tech). Values that are not a plain count ("1:1") stay text.
 */
export function countUpStats(items = []) {
  return items.map((item) => {
    const match = COUNTABLE.exec(String(item.value ?? "").trim());
    if (!match) return item;
    const [, digits, suffix] = match;
    const total = Number(digits);
    return { ...item, value: <CountUp value={total} format={(current) => `${Math.round(current)}${suffix}`} /> };
  });
}

/**
 * Band 6 (`id="about"`): three columns and the live key figures as a
 * description list (hidden while loading, on failure, or when none is shown).
 * `stats` overrides the fetched figures (tests, previews).
 */
export function AboutBand({ theme = "white", stats }) {
  const live = useSiteStats();
  const figures = siteStatValues(Array.isArray(stats) ? stats : live.items);
  return (
    <Band theme={theme} id="about" className="lp-band lp-about" labelledBy="lp-about-title">
      <Column sm={4} md={4} lg={10}>
        <BandHeading id="lp-about-title" title={ABOUT_TITLE} subtitle={ABOUT_SUBTITLE} />
      </Column>
      <Column sm={4} md={8} lg={16}>
        <Reveal as="ul" className="lp-columns">
          {INFO_CARDS.map((card, index) => (
            <li key={card.title} className="lp-columns__item">
              <span className="lp-index">0{index + 1}</span>
              <h3 className="lp-h3">{card.title}</h3>
              <p className="lp-body">{card.body}</p>
            </li>
          ))}
        </Reveal>
      </Column>
      {figures.length ? (
        <Column sm={4} md={8} lg={16}>
          <DataStat items={figures} className="lp-stats" aria-label="Key figures" />
        </Column>
      ) : null}
    </Band>
  );
}

function paragraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Band 7: Our Story / Our Mission (OwlCognito: Our Approach / Our Standard). */
export function StoryBand({ theme = "g100" }) {
  const isOwlCognito = siteBrand.id === "owlcognito";
  const blocks = isOwlCognito ? owlCognitoJourneyBlocks : journeyBlocks;
  return (
    <Band theme={theme} className="lp-band lp-story" labelledBy="lp-story-title">
      <Column sm={4} md={8} lg={9} className="lp-story__text">
        <h2 id="lp-story-title" className="sk-visually-hidden">
          {blocks.map((block) => block.title).join(" and ")}
        </h2>
        <p className="lp-eyebrow lp-eyebrow--rule">{isOwlCognito ? "Private intelligence learning" : "Founded in 2025"}</p>
        {blocks.map((block) => (
          <Reveal key={block.title} className="lp-story__block">
            <h3 className="lp-h2 lp-story__title">{block.title}</h3>
            {paragraphs(block.body).map((text) => (
              <p key={text.slice(0, 32)} className="lp-body lp-story__para">
                {text}
              </p>
            ))}
          </Reveal>
        ))}
      </Column>
      <Column sm={4} md={8} lg={6} start={11} className="lp-story__art">
        <img src={storyIllustration} alt="Knowledge is power illustration" width="960" height="960" loading="lazy" decoding="async" />
      </Column>
    </Band>
  );
}

/** Band 8: why learners choose the brand, three tiles with 32 px icons. */
export function WhyBand({ theme = "g10" }) {
  return (
    <Band theme={theme} className="lp-band lp-why" labelledBy="lp-why-title">
      <Column sm={4} md={4} lg={10}>
        <BandHeading id="lp-why-title" title={WHY_TITLE} subtitle={WHY_SUBTITLE} />
      </Column>
      <Column sm={4} md={8} lg={16}>
        <Reveal as="ul" className="lp-tiles">
          {WHY_CHOOSE.map((item) => (
            <li key={item.title}>
              <Tile className="lp-why__tile">
                <span className="lp-why__icon">
                  <WhyIcon type={item.icon} />
                </span>
                <h3 className="lp-h3">{item.title}</h3>
                <p className="lp-body">{item.body}</p>
              </Tile>
            </li>
          ))}
        </Reveal>
      </Column>
    </Band>
  );
}

/** Band 9: the three steps as an ordered list (horizontal from md, vertical on phones). */
export function JourneyBand({ theme = "g100" }) {
  return (
    <Band theme={theme} className="lp-band lp-journey" labelledBy="lp-journey-title">
      <Column sm={4} md={4} lg={10}>
        <BandHeading id="lp-journey-title" title={JOURNEY_TITLE} subtitle={JOURNEY_SUBTITLE} />
      </Column>
      <Column sm={4} md={8} lg={16}>
        <ProgressIndicator
          label={JOURNEY_TITLE}
          className="lp-journey__steps"
          steps={JOURNEY_STEPS.map((step) => ({ title: step.title, description: step.body }))}
        />
      </Column>
    </Band>
  );
}

/** Band 10: the closing call to action. */
export function CallToActionBand({ theme = "white", joinPath }) {
  return (
    <Band theme={theme} className="lp-band lp-cta" labelledBy="lp-cta-title">
      <Column sm={4} md={4} lg={10}>
        <h2 id="lp-cta-title" className="lp-h2">
          {CTA_TITLE}
        </h2>
        <p className="lp-lead">{CTA_BODY}</p>
      </Column>
      <Column sm={4} md={8} lg={6} className="lp-cta__actions">
        <Button href={joinPath} fullWidth icon={<ArrowRight />}>
          Join now
        </Button>
        <Button href="/courses" kind="secondary" fullWidth icon={<ArrowRight />}>
          Explore courses
        </Button>
      </Column>
    </Band>
  );
}
