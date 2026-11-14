// /bootcamp (PHILOSOPHY T-TRACK, BUILD_PLAN §2.1): the Pentesting Foundations
// bootcamp, the four Foundations courses as numbered phases. "Start bootcamp"
// is disabled with the server's reason while `pentesting` is off or the plan
// is not available; the price shows only once the owner confirms it (D10).
import { Link } from "react-router-dom";

import LineArt from "../marketing/LineArt";
import { mergePlans, PENTESTING_PLANS, planPeriodLabel, planPriceLabel } from "../marketing/plans";
import { ButtonLink, DisabledAction, FaqList, Hand, Notice, StatStrip, Tagline } from "../marketing/primitives";
import { hoursLabel, moduleCount } from "../marketing/tiers";
import { useMarketingData } from "../marketing/useMarketingData";

export const BOOTCAMP_FAQ = [
  {
    q: "Who is the bootcamp for?",
    a: "Anyone starting in security: no prior experience is assumed beyond comfort with a computer.",
  },
  {
    q: "What do I keep?",
    a: "The four Foundations courses stay in your account once the bootcamp is open and bought.",
  },
  {
    q: "When does it open?",
    a: "With the Pentesting launch. Until then you can read every phase and module outline.",
  },
];

function curriculum(course) {
  return Array.isArray(course?.public_curriculum) ? course.public_curriculum : [];
}

export default function BootcampPage() {
  const { gate, tiers, catalog } = useMarketingData();
  const foundations = tiers.find((tier) => tier.key === "foundations")?.courses || [];
  const plan = mergePlans(PENTESTING_PLANS, catalog.plans).find((item) => item.key === "bootcamp");
  const price = planPriceLabel(plan);
  const available = gate.enabled && plan?.state === "available";
  const reason = !gate.enabled ? gate.reason : plan?.reason;
  const modules = foundations.reduce((sum, course) => sum + moduleCount(course), 0);
  const strip = [
    { label: "Phases", value: foundations.length || 4 },
    { label: "Modules", value: modules || null },
    { label: "Format", value: "Self-paced" },
    { label: "Price", value: price ? `${price} ${planPeriodLabel(plan)}`.trim() : "At launch" },
  ];

  return (
    <div data-page="bootcamp">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-bootcamp-title">
        <LineArt name="ladder" className="hp-hero__mark" />
        <Tagline>Four phases, one solid base</Tagline>
        <h1 id="hp-bootcamp-title" className="hp-display hp-display--xl hp-display--track">
          <span className="hp-display__line">Foundations</span> <span className="hp-display__line"><Hand>bootcamp</Hand></span>
        </h1>
        <p className="hp-lead">
          Security principles, the command line, operating-system internals and network protocols: the four courses every later tier assumes.
        </p>
        {gate.enabled ? null : <p className="hp-hero__note">Coming soon: read every phase now, start at launch.</p>}
        <div className="hp-actions">
          {available ? (
            <ButtonLink to={`/pricing?plan=${encodeURIComponent(plan.server_key || plan.key)}#checkout`} variant="accent" size="lg" arrow>
              Start bootcamp
            </ButtonLink>
          ) : (
            <DisabledAction label="Start bootcamp (coming soon)" reason={reason} size="lg" />
          )}
          <ButtonLink to="/tracks/pentesting" variant="secondary" size="lg">
            All Pentesting tiers
          </ButtonLink>
        </div>
        <StatStrip items={strip} label="The bootcamp in numbers" />
      </section>

      <section className="hp-band hp-band--tight-top" aria-labelledby="hp-phases-title">
        <div className="hp-frame" style={{ maxWidth: "64rem" }}>
          <h2 id="hp-phases-title" className="hp-h3">
            The phases
          </h2>
          {foundations.length ? (
            <ol className="hp-tl hp-after-head">
              {foundations.map((course, index) => (
                <li key={course.id} className="hp-tl__step">
                  <span className="hp-tl__dot" aria-hidden="true" />
                  <p className="hp-eyebrow">
                    Phase {index + 1}
                    {moduleCount(course) ? ` · ${moduleCount(course)} modules` : ""}
                    {hoursLabel(course) ? ` · ${hoursLabel(course)}` : ""}
                  </p>
                  <h3 className="hp-tl__heading">
                    <span className="hp-tl__num" aria-hidden="true">
                      {index + 1}.
                    </span>
                    <span className="hp-tl__title">{course.card_title || course.title}</span>
                  </h3>
                  <p className="hp-tl__sub">{course.card_summary || course.summary || course.card_subtitle || ""}</p>
                  {curriculum(course).length ? (
                    <ul className="hp-panel__list" style={{ maxWidth: "36rem" }}>
                      {curriculum(course).map((module, moduleIndex) => (
                        <li key={`${course.id}-${moduleIndex}`}>
                          <span>{module.title || module.name || `Module ${moduleIndex + 1}`}</span>
                          <span className="hp-meta hp-mono">{String(moduleIndex + 1).padStart(2, "0")}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p style={{ marginTop: 16 }}>
                    <Link className="hp-text-link" to={`/courses/${course.id}`}>
                      View the course and its outline →
                    </Link>
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <Notice eyebrow="Coming soon" title="The phases are being prepared" icon="clock" className="hp-after-head">
              The Foundations courses appear here as soon as they are published for browsing.
            </Notice>
          )}
        </div>
      </section>

      <section className="hp-band hp-rule-top" aria-labelledby="hp-bootcamp-faq-title">
        <div className="hp-frame" style={{ maxWidth: "56rem" }}>
          <div className="hp-section-head hp-section-head--center">
            <p className="hp-faq-kicker">FAQ</p>
            <h2 id="hp-bootcamp-faq-title" className="hp-h2">
              Bootcamp <Hand>questions</Hand>
            </h2>
          </div>
          <FaqList items={BOOTCAMP_FAQ} className="hp-after-head" />
        </div>
      </section>
    </div>
  );
}
