import { formatINR } from "../utils/currency";

export function availablePaymentPlans(course) {
  return [
    { id: "monthly", label: "Monthly", enabled: course.installment_payment_enabled, amount: Number(course.monthly_price), count: course.installments_required, interval: "per month" },
    { id: "bundle", label: "3-month bundle", enabled: course.bundle_payment_enabled, amount: Number(course.bundle_price), count: course.bundle_installments, interval: "per installment" },
    { id: "full", label: "One-time", enabled: course.full_payment_enabled, amount: Number(course.price), count: 1, interval: "single payment" },
  ].filter((plan) => plan.enabled && plan.amount > 0);
}

export default function PaymentPlanPicker({ course, value, onChange }) {
  const plans = availablePaymentPlans(course);
  return <div className="payment-plan-grid" role="group" aria-label="Payment plans">
    {plans.map((plan) => <button type="button" key={plan.id} className={`payment-plan ${value === plan.id ? "selected" : ""}`} aria-pressed={value === plan.id} onClick={() => onChange(plan.id)}>
      <span className="payment-plan-label">{plan.label}</span>
      <strong>{formatINR(plan.amount)}</strong><span>{plan.interval}</span>
      <div className="payment-plan-total">{plan.count} {plan.count === 1 ? "payment" : "payments"}<br />{formatINR(plan.amount * plan.count)} total</div>
      <ul><li>Complete course curriculum</li><li>{course.duration || "Full program duration"}</li><li>Same learning benefits in every plan</li></ul>
      <span className="payment-plan-choice">{value === plan.id ? "Selected ✓" : "Select plan"}</span>
    </button>)}
    {!plans.length && <p role="status">Enrollment pricing will be announced. Contact the team for updates.</p>}
  </div>;
}
