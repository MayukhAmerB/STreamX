// Pricing cards (PHILOSOPHY §2.7 / T5): one highlighted plan (golden hairline,
// wash, glow, tactile CTA), the Free card's black pill, "Price at launch" until
// the owner confirms a price, and calm disabled-with-reason CTAs.
import { useId } from "react";

import { ButtonLink, CheckIcon, cx, DashIcon, DisabledAction } from "./primitives";
import { planHref, planPeriodLabel, planPriceLabel, PRICE_AT_LAUNCH } from "./plans";

export function PricingCard({ plan, headingLevel: Heading = "h3" }) {
  const titleId = useId();
  const price = planPriceLabel(plan);
  const highlighted = Boolean(plan.highlighted);
  const available = plan.state === "available";
  const isFree = plan.key === "free";
  return (
    <article className={cx("hp-plan", highlighted && "hp-plan--highlighted")} aria-labelledby={titleId} data-plan={plan.key} data-state={plan.state}>
      {plan.badge ? <span className="hp-plan__badge">{plan.badge}</span> : null}
      <Heading id={titleId} className="hp-plan__name">
        {plan.title}
      </Heading>
      <p className="hp-plan__price">
        {price ? (
          <>
            <span className="hp-plan__amount">{price}</span>
            <span className="hp-plan__period">{planPeriodLabel(plan)}</span>
          </>
        ) : (
          <span className="hp-plan__amount hp-plan__amount--pending">{PRICE_AT_LAUNCH}</span>
        )}
      </p>
      {plan.terms ? <p className="hp-plan__terms">{plan.terms}</p> : null}
      {plan.slot ? <div className="hp-plan__note">{plan.slot}</div> : plan.note ? <p className="hp-plan__note">{plan.note}</p> : null}
      <div className="hp-plan__divider" aria-hidden="true" />
      <ul className="hp-plan__features">
        {(plan.features || []).map((feature) => (
          <li key={feature.text} data-included={feature.included === false ? "false" : "true"}>
            <span className="hp-plan__mark">{feature.included === false ? <DashIcon /> : <CheckIcon />}</span>
            <span>
              {feature.text}
              <span className="hp-sr">{feature.included === false ? " (not included)" : " (included)"}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="hp-plan__cta">
        {available ? (
          <ButtonLink
            to={planHref(plan)}
            variant={highlighted ? "accent" : "secondary"}
            className={isFree ? "hp-btn--plan-free" : highlighted ? "hp-btn--plan-tactile" : undefined}
            arrow
          >
            {plan.cta_label || "Choose plan"}
          </ButtonLink>
        ) : (
          <DisabledAction label={`${plan.cta_label || "Choose plan"} (coming soon)`} reason={plan.reason} variant="secondary" block />
        )}
      </div>
    </article>
  );
}

export function PricingGrid({ plans, columns = 3, headingLevel }) {
  return (
    <div className={cx("hp-plans", columns === 3 && "hp-plans--3")}>
      {plans.map((plan) => (
        <PricingCard key={plan.key} plan={plan} headingLevel={headingLevel} />
      ))}
    </div>
  );
}
