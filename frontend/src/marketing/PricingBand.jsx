// The pricing band shared by the landing page, the catalogue and /pricing
// (T5): section h2 with one handwritten word, a lead, trust chips, then the
// OSINT plans (Free, Starter, CTF Labs membership). Plans and their state come
// from GET /api/catalog/ (useCatalog); the descriptors only fill the gaps.
import { useCatalog } from "./catalogApi";
import { mergePlans, OSINT_PLANS } from "./plans";
import { PricingGrid } from "./Pricing";
import { PRICING_BAND } from "./marketingContent";
import { ButtonLink, Hand } from "./primitives";

export const TRUST_CHIPS = ["Payments through Razorpay", "Prices in Indian rupees", "No card for the Free plan"];

export default function PricingBand({ id = "pricing", catalog: catalogProp, headingLevel = "h2", showLink = true }) {
  const fetched = useCatalog();
  const catalog = catalogProp || fetched;
  const plans = mergePlans(OSINT_PLANS, catalog.plans);
  const Heading = headingLevel;
  const headingId = `${id}-title`;
  return (
    <section id={id} className="hp-band hp-band--lg" aria-labelledby={headingId}>
      <div className="hp-frame">
        <div className="hp-pricing-head">
          <Heading id={headingId} className="hp-h2">
            {PRICING_BAND.before} <Hand>{PRICING_BAND.accent}</Hand>
            {PRICING_BAND.after}
          </Heading>
          <p className="hp-lead" style={{ marginTop: 20 }}>
            {PRICING_BAND.lead}
          </p>
          <ul className="hp-trust" aria-label={PRICING_BAND.trustLabel}>
            {TRUST_CHIPS.map((chip) => (
              <li key={chip}>{chip}</li>
            ))}
          </ul>
        </div>
        <PricingGrid plans={plans} columns={3} headingLevel={headingLevel === "h2" ? "h3" : "h2"} />
        {showLink ? (
          <div className="hp-actions" style={{ justifyContent: "center", marginTop: 32 }}>
            <ButtonLink to="/pricing" variant="secondary" arrow>
              {PRICING_BAND.compareCta}
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </section>
  );
}
