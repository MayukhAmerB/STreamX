// /about (PHILOSOPHY T-HOME bands, BUILD_PLAN §2.1): a display headline with
// one handwritten word, the mission story with our own photograph in
// greyscale, a numbered "How we teach" timeline and a closing call to action.
import storyMission from "../assets/story-mission.webp";
import { ABOUT } from "../marketing/marketingContent";
import { ButtonLink, CheckList, DisplayHeading, Eyebrow, Hand, Tagline } from "../marketing/primitives";
import SiteStatStrip from "../marketing/SiteStatStrip";

// Copy lives in marketing/marketingContent.js (ABOUT).
export const ABOUT_PILLARS = ABOUT.pillars;
export const ABOUT_TEACH = ABOUT.teach;

export default function AboutPage() {
  return (
    <div data-page="about">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-about-page-title">
        <Tagline>{ABOUT.tagline}</Tagline>
        <h1 id="hp-about-page-title" className="hp-display hp-display--xl">
          <span className="hp-display__line">{ABOUT.line1}</span>{" "}
          <span className="hp-display__line">
            {ABOUT.line2Before ? `${ABOUT.line2Before} ` : null}
            <Hand>{ABOUT.accent}</Hand>
            {ABOUT.line2Before ? "." : null}
          </span>
        </h1>
        <p className="hp-lead">{ABOUT.lead}</p>
        <SiteStatStrip label="About us in numbers" />
      </section>

      <section className="hp-band hp-band--tight-top" aria-labelledby="hp-mission-title">
        <div className="hp-frame">
          <div className="hp-story">
            <div>
              <Eyebrow>{ABOUT.missionEyebrow}</Eyebrow>
              <h2 id="hp-mission-title" className="hp-h3" style={{ marginTop: 12 }}>
                {ABOUT.missionTitle}
              </h2>
              {ABOUT.missionBody.map((paragraph) => (
                <p key={paragraph} className="hp-body" style={{ marginTop: 16 }}>
                  {paragraph}
                </p>
              ))}
              <CheckList items={ABOUT_PILLARS} />
            </div>
            <figure className="hp-detail__art" style={{ aspectRatio: "1 / 1", padding: 0 }}>
              <img src={storyMission} alt="Learners working through an investigation together" width="960" height="960" loading="lazy" decoding="async" />
            </figure>
          </div>
        </div>
      </section>

      <section className="hp-band hp-band--lg hp-rule-top" aria-labelledby="hp-teach-title">
        <div className="hp-frame">
          <div className="hp-stack-center">
            <DisplayHeading id="hp-teach-title" lines={ABOUT.teachLines} periods />
          </div>
          <ol className="hp-tl hp-after-head" style={{ maxWidth: "48rem", marginInline: "auto" }}>
            {ABOUT_TEACH.map((step, index) => (
              <li key={step.title} className="hp-tl__step">
                <span className="hp-tl__dot" aria-hidden="true" />
                <h3 className="hp-tl__heading">
                  <span className="hp-tl__num" aria-hidden="true">
                    {index + 1}.
                  </span>
                  <span className="hp-tl__title">{step.title}</span>
                </h3>
                <p className="hp-tl__sub">{step.sub}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-about-cta-title">
        <div className="hp-frame hp-stack-center">
          <h2 id="hp-about-cta-title" className="hp-h2">
            {ABOUT.ctaBefore} <Hand>{ABOUT.ctaAccent}</Hand>
          </h2>
          <p className="hp-lead" style={{ marginTop: 20 }}>
            {ABOUT.ctaLead}
          </p>
          <div className="hp-actions" style={{ marginTop: 32 }}>
            <ButtonLink to="/courses" variant="primary" size="lg" arrow>
              {ABOUT.ctaPrimary}
            </ButtonLink>
            <ButtonLink to="/contact" variant="secondary" size="lg">
              {ABOUT.ctaSecondary}
            </ButtonLink>
          </div>
        </div>
      </section>
    </div>
  );
}
