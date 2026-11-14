// /tracks/:track (PHILOSOPHY T3 + bootcamp hero, BUILD_PLAN §2.1): the OSINT
// and Pentesting track pages. Pentesting is a whole "Coming soon" section:
// every tier, course and module outline is browsable, and every enrol/buy
// control is disabled with the server's reason until the `pentesting` switch
// is turned on (the server answers 403 feature_disabled meanwhile).
import { useParams } from "react-router-dom";

import { EXAM_LAB, FREE_TIER, labAccess, LABS, labUrl } from "../data/freeLabs";
import { labsMembershipRequired } from "../marketing/catalogApi";
import { CourseCatalogCard, LabCatalogCard, TierSection } from "../marketing/CatalogCard";
import LineArt from "../marketing/LineArt";
import { OSINT_TRACK, PENTESTING_TRACK } from "../marketing/marketingContent";
import PricingBand from "../marketing/PricingBand";
import {
  ButtonLink,
  DisabledAction,
  Eyebrow,
  FaqList,
  Hand,
  Notice,
  StatStrip,
  Tagline,
} from "../marketing/primitives";
import { PENTESTING_TIERS, trackForSlug } from "../marketing/tiers";
import { useMarketingData } from "../marketing/useMarketingData";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import NotFoundPage from "./NotFoundPage";

export const PENTESTING_FAQ = [
  {
    q: "Can I enrol in Pentesting today?",
    a: "Not yet. Every tier, course and module outline is open to browse now, and enrolment opens at launch. Nothing can be bought or started before then.",
  },
  {
    q: "Where should a beginner start?",
    a: "Foundations: security principles, the command line, operating-system internals, and packets and protocols. Everything later builds on them.",
  },
  {
    q: "Will it be self-paced or live?",
    a: "Both: self-paced modules with exercises and labs, and live sessions for the cohorts that run alongside them.",
  },
  {
    q: "What will it cost?",
    a: "Prices are published on the pricing page once they are confirmed. Until then the plans say \"Price at launch\" and nothing is charged.",
  },
];

export const OSINT_FAQ = [
  {
    q: "Can I start without paying?",
    a: "Yes. The free plan is a curated directory of free OSINT challenges on other platforms, our learning path through them and the monthly live CTF.",
  },
  {
    q: "What are the labs?",
    a: "Our own investigation cases on labs.alsyedinitiative.com, from easy to professional, with exact-answer validation.",
  },
  {
    q: "How do the live cohorts work?",
    a: "Three live sessions a week (Fri, Sat and Sun, 7 PM IST), protected recordings, a weekly report marked by an instructor, then the timed examination and a certificate anyone can verify.",
  },
];

function PentestingTrack({ data }) {
  const { gate, tiers, stats } = data;
  const strip = [
    { label: "Tiers", value: PENTESTING_TIERS.length },
    { label: "Courses", value: stats.pentestingCourses || null },
    { label: "Modules", value: stats.pentestingModules || null },
    { label: "Format", value: "Self-paced + live" },
  ];
  return (
    <>
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-track-title">
        <LineArt name="foundations" className="hp-hero__mark" />
        <Tagline>{PENTESTING_TRACK.tagline}</Tagline>
        <h1 id="hp-track-title" className="hp-display hp-display--xl hp-display--track">
          <span className="hp-display__line">Penetration</span> <span className="hp-display__line"><Hand>testing</Hand></span>
        </h1>
        <p className="hp-lead">{PENTESTING_TRACK.lead}</p>
        {gate.enabled ? null : <p className="hp-hero__note">{PENTESTING_TRACK.soonNote}</p>}
        <div className="hp-actions">
          {gate.enabled ? (
            <ButtonLink to="/pricing#pentesting" variant="primary" size="lg" arrow>
              {PENTESTING_TRACK.plansCta}
            </ButtonLink>
          ) : (
            <DisabledAction label="Enrol (coming soon)" reason={gate.reason} size="lg" />
          )}
          <ButtonLink to="#tiers" variant="secondary" size="lg">
            {PENTESTING_TRACK.tiersCta}
          </ButtonLink>
        </div>
        <StatStrip items={strip} label="Pentesting in numbers" />
      </section>

      <section className="hp-band hp-band--tight-top" id="tiers" aria-labelledby="hp-tiers-title">
        <div className="hp-frame">
          {gate.enabled ? null : (
            <Notice eyebrow={PENTESTING_TRACK.notice.eyebrow} title={PENTESTING_TRACK.notice.title} icon="clock">
              {PENTESTING_TRACK.notice.body}
            </Notice>
          )}
          <h2 id="hp-tiers-title" className="hp-sr">
            Pentesting tiers
          </h2>
          {tiers.length ? (
            <div className="hp-tiers">
              {tiers.map((tier, index) => (
                <TierSection key={tier.key} id={`tier-${tier.key}`} kicker={`Tier ${index + 1}`} title={tier.label} summary={tier.summary} count={tier.courses.length}>
                  {tier.courses.map((course) => (
                    <li key={course.id}>
                      <CourseCatalogCard course={course} />
                    </li>
                  ))}
                </TierSection>
              ))}
            </div>
          ) : (
            <div className="hp-tiers">
              {PENTESTING_TIERS.map((tier, index) => (
                <section key={tier.key} className="hp-tier" aria-labelledby={`tier-${tier.key}-title`}>
                  <div className="hp-tier__head">
                    <div>
                      <p className="hp-eyebrow hp-tier__kicker">Tier {index + 1}</p>
                      <h3 id={`tier-${tier.key}-title`} className="hp-tier__title">
                        {tier.label}
                      </h3>
                      <p className="hp-tier__summary">{tier.summary}</p>
                    </div>
                    <p className="hp-tier__count">Courses being prepared</p>
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-track-faq-title">
        <div className="hp-frame" style={{ maxWidth: "56rem" }}>
          <div className="hp-section-head hp-section-head--center">
            <p className="hp-faq-kicker">{PENTESTING_TRACK.faq.kicker}</p>
            <h2 id="hp-track-faq-title" className="hp-h2">
              {PENTESTING_TRACK.faq.before} <Hand>{PENTESTING_TRACK.faq.accent}</Hand>
            </h2>
          </div>
          <FaqList items={PENTESTING_FAQ} className="hp-after-head" />
        </div>
      </section>
    </>
  );
}

function OsintTrack({ data }) {
  const { catalog, osint, stats } = data;
  const membersOnly = labsMembershipRequired(catalog);
  const cohort = osint.find((course) => getCourseLaunchStatus(course).isLive && !course?.registration_closed) || null;
  const strip = [
    { label: "Free challenges", value: stats.freeChallenges || "Free" },
    { label: "Labs", value: LABS.length },
    { label: "Live cohorts", value: osint.length || null },
    { label: "Exam", value: OSINT_TRACK.examStat },
  ];
  return (
    <>
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-track-title">
        <LineArt name="magnifier" className="hp-hero__mark" />
        <Tagline>{OSINT_TRACK.tagline}</Tagline>
        <h1 id="hp-track-title" className="hp-display hp-display--xl hp-display--track">
          <span className="hp-display__line">Open Source</span> <span className="hp-display__line"><Hand>Intelligence</Hand></span>
        </h1>
        <p className="hp-lead">{OSINT_TRACK.lead}</p>
        <div className="hp-actions">
          {cohort ? (
            <ButtonLink to={`/courses/${cohort.id}`} variant="primary" size="lg" arrow>
              {OSINT_TRACK.cohortCta}
            </ButtonLink>
          ) : (
            <ButtonLink to="/courses?category=osint" variant="primary" size="lg" arrow>
              {OSINT_TRACK.coursesCta}
            </ButtonLink>
          )}
          <ButtonLink to={FREE_TIER.href} variant="secondary" size="lg">
            {OSINT_TRACK.freeCta}
          </ButtonLink>
        </div>
        <StatStrip items={strip} label="OSINT in numbers" />
      </section>

      <section className="hp-band hp-band--tight-top" id="free" aria-labelledby="hp-free-title">
        <div className="hp-frame">
          <div className="hp-section-head hp-section-head--split">
            <div className="hp-section-head__copy">
              <Eyebrow>{OSINT_TRACK.freeEyebrow}</Eyebrow>
              <h2 id="hp-free-title" className="hp-h3">
                {OSINT_TRACK.freeTitle}
              </h2>
              <p className="hp-body">{FREE_TIER.summary}</p>
            </div>
            <ButtonLink to={FREE_TIER.href} variant="primary" size="sm" arrow>
              {OSINT_TRACK.freeCta}
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className="hp-band hp-band--tight-top" id="labs" aria-labelledby="hp-labs-title">
        <div className="hp-frame">
          <TierSection
            id="labs-tier"
            kicker={membersOnly ? "Members only" : "Open now"}
            title={OSINT_TRACK.labsTitle}
            summary={membersOnly ? OSINT_TRACK.labsMembers : OSINT_TRACK.labsOpen}
            count={LABS.length}
            countLabel="lab"
          >
            {LABS.map((lab) => (
              <li key={lab.id}>
                <LabCatalogCard lab={lab} access={labAccess(lab, { membershipRequired: membersOnly })} href={labUrl(lab.tab)} />
              </li>
            ))}
          </TierSection>
          <p className="hp-meta" style={{ marginTop: 16 }}>
            {EXAM_LAB.index} · {EXAM_LAB.title}: {EXAM_LAB.summary}
          </p>
        </div>
      </section>

      {osint.length ? (
        <section className="hp-band hp-band--tight-top" id="cohorts" aria-labelledby="hp-cohorts-title">
          <div className="hp-frame">
            <TierSection id="cohorts-tier" kicker="Live" title={OSINT_TRACK.cohortsTitle} summary={OSINT_TRACK.cohortsSummary} count={osint.length}>
              {osint.map((course) => (
                <li key={course.id}>
                  <CourseCatalogCard course={course} />
                </li>
              ))}
            </TierSection>
          </div>
        </section>
      ) : null}

      <PricingBand id="osint-pricing" showLink />

      <section className="hp-band hp-rule-top" aria-labelledby="hp-track-faq-title">
        <div className="hp-frame" style={{ maxWidth: "56rem" }}>
          <div className="hp-section-head hp-section-head--center">
            <p className="hp-faq-kicker">{OSINT_TRACK.faq.kicker}</p>
            <h2 id="hp-track-faq-title" className="hp-h2">
              {OSINT_TRACK.faq.before} <Hand>{OSINT_TRACK.faq.accent}</Hand>
            </h2>
          </div>
          <FaqList items={OSINT_FAQ} className="hp-after-head" />
        </div>
      </section>
    </>
  );
}

export default function TrackPage() {
  const { track } = useParams();
  const definition = trackForSlug(track);
  const data = useMarketingData();
  if (!definition) return <NotFoundPage />;
  return <div data-track-page={definition.slug}>{definition.slug === "pentesting" ? <PentestingTrack data={data} /> : <OsintTrack data={data} />}</div>;
}
