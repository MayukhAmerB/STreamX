import { useEffect, useId, useRef, useState } from "react";
import { splitPriceLabel } from "./paymentPlans";
import "./PaymentPlanCards.css";

/** Carousel side inset in px; matches `--ppc-inset` in PaymentPlanCards.css. */
const CAROUSEL_INSET = 12;

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m3.5 8.4 2.9 2.9 6.1-6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AccessIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.8V8l2.2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ctaText(plan, { disabled, busy }) {
  if (!plan.available) return "Unavailable";
  if (disabled) return "Enrollment unavailable";
  if (busy) return "Opening secure checkout…";
  return plan.ctaLabel;
}

function ctaAriaLabel(plan, { disabled, busy }) {
  if (!plan.available) return `${plan.title} plan is unavailable`;
  if (disabled) return `${plan.title} plan enrollment is unavailable`;
  if (busy) return `Opening secure checkout for the ${plan.title} plan`;
  return `${plan.ctaLabel}: ${plan.title} plan, ${plan.priceLabel}`;
}

/**
 * Admin-configured plan cards (2-4) for the website checkout.
 *
 * Semantics: one native radio group (arrow keys move the selection, disabled
 * plans are skipped) plus a call-to-action per card that selects the plan and
 * continues, exactly like the legacy "Enroll Now" buttons. Desktop columns
 * follow `columns`; tablets get two columns once there are 3+ cards; phones
 * get a snap carousel with the next card peeking (container queries, so the
 * layout follows the space the cards actually have).
 */
export default function PaymentPlanCards({
  plans,
  columns,
  courseFeatures = [],
  value,
  onChange,
  onContinue,
  disabled = false,
  busyPlan = "",
}) {
  const groupId = useId();
  const scrollerRef = useRef(null);
  const [visibleIndex, setVisibleIndex] = useState(0);
  const count = plans.length;

  // Phones: the carousel starts at plan 1 (the admin's order, next card
  // peeking); track which card is in view for the pager.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return undefined;
    const cards = () => Array.from(scroller.children || []).filter((node) => node?.dataset?.planCard === "true");
    const isCarousel = () => scroller.scrollWidth > scroller.clientWidth + 1;
    let frame = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const list = cards();
        if (!list.length || !isCarousel()) return;
        const left = scroller.scrollLeft + CAROUSEL_INSET;
        let nearest = 0;
        list.forEach((card, index) => {
          if (Math.abs(card.offsetLeft - left) < Math.abs(list[nearest].offsetLeft - left)) nearest = index;
        });
        setVisibleIndex(nearest);
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [count]);

  const scrollToCard = (index) => {
    const scroller = scrollerRef.current;
    const target = Array.from(scroller?.children || []).filter((node) => node?.dataset?.planCard === "true")[index];
    if (!scroller || !target) return;
    const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollTo({ left: target.offsetLeft - CAROUSEL_INSET, behavior: reduceMotion ? "auto" : "smooth" });
  };

  if (!count) {
    return (
      <p className="ppc-empty" role="status">
        Enrollment pricing will be announced. Contact the team for updates.
      </p>
    );
  }

  const fallbackFeatures = courseFeatures.filter(Boolean).slice(0, 5);

  return (
    <div className="ppc" data-count={count}>
      <fieldset className="ppc-fieldset">
        <legend className="ppc-sr-only">Choose a payment plan</legend>
        <div
          ref={scrollerRef}
          className={`ppc-grid ppc-grid--cols-${columns}`}
          data-columns={columns}
          data-count={count}
        >
          {plans.map((plan) => {
            const selected = value === plan.id;
            const busy = busyPlan === plan.id;
            const ctaDisabled = !plan.available || disabled || Boolean(busyPlan);
            const inputId = `${groupId}-plan-${plan.id}`;
            const titleId = `${inputId}-title`;
            const priceId = `${inputId}-price`;
            const reasonId = `${inputId}-reason`;
            const price = splitPriceLabel(plan.priceLabel);
            const features = plan.features.length ? plan.features : fallbackFeatures;
            const cardClass = [
              "ppc-card",
              plan.highlighted ? "ppc-card--highlighted" : "",
              selected ? "ppc-card--selected" : "",
              plan.available ? "" : "ppc-card--unavailable",
              plan.badge ? "ppc-card--badged" : "",
            ].filter(Boolean).join(" ");

            return (
              <div key={plan.id} className={cardClass} data-plan-card="true" data-plan={plan.id}>
                <input
                  id={inputId}
                  className="ppc-radio"
                  type="radio"
                  name={`${groupId}-payment-plan`}
                  value={plan.id}
                  checked={selected}
                  disabled={!plan.available}
                  aria-labelledby={`${titleId} ${priceId}`}
                  aria-describedby={plan.available ? undefined : reasonId}
                  onChange={() => onChange?.(plan.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (!ctaDisabled) {
                      onChange?.(plan.id);
                      onContinue?.(plan.id);
                    }
                  }}
                />

                {plan.badge ? (
                  <span className="ppc-badge">{plan.badge}</span>
                ) : null}

                <div className="ppc-head">
                  <div className="ppc-kicker">
                    <span className="ppc-number">Plan {String(plan.number).padStart(2, "0")}</span>
                    <span className="ppc-indicator" aria-hidden="true">
                      <span className="ppc-indicator-dot">{selected ? <CheckIcon /> : null}</span>
                      <span className="ppc-indicator-label">{selected ? "Selected" : plan.available ? "Select" : "Unavailable"}</span>
                    </span>
                  </div>
                  <h3 id={titleId} className="ppc-title">{plan.title}</h3>
                  {plan.subtitle ? <p className="ppc-subtitle">{plan.subtitle}</p> : null}
                </div>

                <div className="ppc-price" id={priceId}>
                  <p className="ppc-price-line">
                    <span className="ppc-amount">{price.amount}</span>
                    {price.suffix ? <span className="ppc-interval">{price.suffix}</span> : null}
                  </p>
                  {plan.totalLabel ? (
                    <p className="ppc-total">{plan.totalLabel}</p>
                  ) : plan.installments && plan.installments > 1 ? (
                    <p className="ppc-total">{plan.installments} payments</p>
                  ) : null}
                </div>

                <div className="ppc-access">
                  {plan.accessLabel ? (
                    <p className="ppc-access-chip">
                      <AccessIcon />
                      <span>{plan.accessLabel}</span>
                    </p>
                  ) : null}
                </div>

                <div className="ppc-features">
                  {features.length ? (
                    <ul aria-label={`${plan.title} plan includes`}>
                      {features.map((feature) => (
                        <li key={feature}>
                          <span className="ppc-feature-icon"><CheckIcon /></span>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {/* In the stretchy features row so the reason never pushes every card's button down. */}
                  {!plan.available ? (
                    <p className="ppc-reason" id={reasonId}>
                      <LockIcon />
                      <span>{plan.unavailableReason}</span>
                    </p>
                  ) : null}
                </div>

                <div className="ppc-foot">
                  <button
                    type="button"
                    className="ppc-cta"
                    onClick={() => {
                      onChange?.(plan.id);
                      onContinue?.(plan.id);
                    }}
                    disabled={ctaDisabled}
                    aria-label={ctaAriaLabel(plan, { disabled, busy })}
                  >
                    <span>{ctaText(plan, { disabled, busy })}</span>
                    {!ctaDisabled ? <ArrowIcon /> : null}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {count > 1 ? (
        <div className="ppc-pager" aria-hidden="true">
          {plans.map((plan, index) => (
            <button
              key={plan.id}
              type="button"
              tabIndex={-1}
              className={`ppc-pager-dot ${index === visibleIndex ? "ppc-pager-dot--active" : ""}`.trim()}
              onClick={() => scrollToCard(index)}
            />
          ))}
          <span className="ppc-pager-count">{visibleIndex + 1} / {count}</span>
        </div>
      ) : null}
    </div>
  );
}
