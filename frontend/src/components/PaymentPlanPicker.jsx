import { formatINR } from "../utils/currency";

const FALLBACK_FEATURES = [
  "Complete configured course curriculum",
  "Access issued after verified payment",
  "Server-authoritative pricing",
  "Razorpay-secured checkout",
];

function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function availablePaymentPlans(course = {}) {
  const monthlyCount = positiveNumber(course.installments_required, 1);
  const bundleCount = positiveNumber(course.bundle_installments, 1);
  const bundleAccessDays = positiveNumber(course.bundle_access_days);
  const plans = [
    {
      id: "monthly",
      number: 1,
      label: "Monthly",
      enabled: course.installment_payment_enabled,
      amount: positiveNumber(course.monthly_price),
      count: monthlyCount,
      interval: "/ month",
      paymentSummary: `${monthlyCount} monthly ${monthlyCount === 1 ? "payment" : "payments"}`,
      accessLabel: positiveNumber(course.installment_access_days)
        ? `${positiveNumber(course.installment_access_days)}-day access per installment`
        : "Monthly course access",
    },
    {
      id: "full",
      number: 2,
      label: "One-Time",
      enabled: course.full_payment_enabled,
      amount: positiveNumber(course.price),
      count: 1,
      interval: "one payment",
      paymentSummary: "Paid once",
      accessLabel: "Lifetime access",
      featured: true,
    },
    {
      id: "bundle",
      number: 3,
      label: bundleAccessDays === 90 ? "3-Month Bundle" : bundleAccessDays ? `${bundleAccessDays}-Day Bundle` : "Bundle",
      enabled: course.bundle_payment_enabled,
      amount: positiveNumber(course.bundle_price),
      count: bundleCount,
      interval: "/ installment",
      paymentSummary: `${bundleCount} bundle ${bundleCount === 1 ? "payment" : "payments"}`,
      accessLabel: bundleAccessDays
        ? `${bundleAccessDays}-day access window`
        : "Bundle course access",
    },
  ];

  return plans
    .filter((plan) => plan.enabled && plan.amount > 0)
    .map((plan) => ({ ...plan, total: plan.amount * plan.count }));
}

function FeatureIcon({ type }) {
  if (type === "recording") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3.5" y="5" width="13" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="m16.5 9 4-2v10l-4-2V9Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === "support") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 13v-2a8 8 0 0 1 16 0v2M6.5 18H6a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h.5v6Zm11 0h.5a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-.5v6ZM17.5 18c-.8 1.3-2.4 2-4.5 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (type === "chat") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M8 11h.01M12 11h.01M16 11h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="m10 8 6 4-6 4V8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
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

function planFeatures(course) {
  const configured = Array.isArray(course.course_card_features)
    ? course.course_card_features
        .filter((feature) => feature && String(feature.title || "").trim())
        .slice(0, 4)
        .map((feature) => ({
          icon: feature.icon || "check",
          title: String(feature.title).trim(),
        }))
    : [];

  return configured.length
    ? configured
    : FALLBACK_FEATURES.map((title, index) => ({
        icon: ["live", "check", "check", "check"][index],
        title,
      }));
}

export default function PaymentPlanPicker({
  course,
  value,
  onChange,
  onContinue,
  disabled = false,
  busyPlan = "",
}) {
  const plans = availablePaymentPlans(course);
  const features = planFeatures(course);

  const choosePlan = (planId) => {
    onChange?.(planId);
    onContinue?.(planId);
  };

  return (
    <div className="payment-plan-grid" role="list" aria-label="Available payment plans">
      {plans.map((plan) => {
        const selected = value === plan.id;
        const busy = busyPlan === plan.id;
        return (
          <article
            role="listitem"
            key={plan.id}
            className={`payment-plan-card ${plan.featured ? "payment-plan-card-featured" : ""} ${selected ? "payment-plan-card-selected" : ""}`.trim()}
          >
            <div className="payment-plan-card-body">
              <div className="payment-plan-price-column">
                <div className="payment-plan-badges">
                  <span className="payment-plan-number">PLAN {plan.number}</span>
                  {plan.featured ? <span className="payment-plan-access-badge">LIFETIME ACCESS</span> : null}
                  {selected ? <span className="payment-plan-selected-badge">SELECTED</span> : null}
                </div>
                <h4>{plan.label}</h4>
                <div className="payment-plan-price-row">
                  <strong>{formatINR(plan.amount)}</strong>
                  <span>{plan.interval}</span>
                </div>
                <p className="payment-plan-access-line">{plan.accessLabel}</p>
                <p className="payment-plan-total-line">
                  {plan.paymentSummary}
                  <span aria-hidden="true"> • </span>
                  {formatINR(plan.total)} total
                </p>
              </div>

              <div className="payment-plan-card-divider" aria-hidden="true" />

              <ul className="payment-plan-feature-list" aria-label={`${plan.label} plan includes`}>
                {features.map((feature) => (
                  <li key={`${plan.id}-${feature.title}`}>
                    <span className="payment-plan-feature-icon">
                      <FeatureIcon type={feature.icon} />
                    </span>
                    <span>{feature.title}</span>
                  </li>
                ))}
              </ul>
            </div>

            {plan.featured ? (
              <div className="payment-plan-lifetime-panel">
                <div className="payment-plan-lifetime-title">
                  <span aria-hidden="true">★</span>
                  ONE PAYMENT. LIFETIME ACCESS.
                </div>
                <ul>
                  <li>Complete configured course curriculum</li>
                  <li>No recurring installment schedule</li>
                  <li>Access remains active after successful verification</li>
                </ul>
              </div>
            ) : null}

            <button
              type="button"
              className="payment-plan-action"
              onClick={() => choosePlan(plan.id)}
              disabled={disabled || Boolean(busyPlan)}
              aria-label={disabled
                ? `${plan.label} plan enrollment is unavailable`
                : busy
                  ? `Opening secure checkout for the ${plan.label} plan`
                  : `Enroll with the ${plan.label} plan for ${formatINR(plan.amount)} ${plan.interval}`}
              aria-pressed={selected}
            >
              <span>{disabled ? "Enrollment unavailable" : busy ? "Opening secure checkout…" : "Enroll Now"}</span>
              {!disabled && !busy ? <ArrowIcon /> : null}
            </button>
          </article>
        );
      })}
      {!plans.length ? (
        <p className="payment-plan-empty" role="status">
          Enrollment pricing will be announced. Contact the team for updates.
        </p>
      ) : null}
    </div>
  );
}
