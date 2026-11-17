import { useRef, useState } from "react";
import { Link } from "react-router-dom";

import { siteBrand } from "../../config/siteBrand";
import { useAuth } from "../../hooks/useAuth";
import { AuthMessage, AuthSubmit } from "../../marketing/auth/AuthControls";
import { platformCheckoutError, platformPlanGate, startPlatformCheckout } from "./platformCheckout";
import "../../marketing/auth/auth.css";

/**
 * The buy / subscribe control for one platform plan (pricing page cards,
 * T-PRICE). Disabled, never hidden: while the plan is not available (switch
 * off, plan disabled, price unconfirmed) the button stays focusable with
 * aria-disabled and the reason is visible text. Signed-out visitors get a
 * sign-in link that returns to `returnTo`.
 *
 * Props: plan (catalog plan object), gates (catalog gates), returnTo,
 * onPaid(data) after a verified payment, checkout (test seam).
 */
export default function PlatformPlanCheckout({ plan, gates = null, returnTo = "/pricing", onPaid, checkout = startPlatformCheckout, className = "" }) {
  const { isAuthenticated, user } = useAuth() || {};
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [message, setMessage] = useState(null);
  const gate = platformPlanGate(plan, { gates });
  const label = plan?.cta_label || (plan?.billing_period ? "Subscribe" : "Buy");

  if (!gate.blocked && !isAuthenticated) {
    return (
      <div className={`au-scope ${className}`.trim()}>
        <Link className="au-submit" to={`/login?next=${encodeURIComponent(returnTo)}`}>
          <span>Sign in to {label.toLowerCase()}</span>
        </Link>
      </div>
    );
  }

  const run = async () => {
    // Synchronous guard: a double click never opens two orders.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = await checkout(plan, {
        brandName: siteBrand.name,
        prefill: { name: user?.full_name || user?.name || "", email: user?.email || "" },
      });
      if (result?.status === "paid") {
        setMessage({ tone: "success", text: "Payment verified. Your access is ready in the Console." });
        onPaid?.(result.data);
      } else if (result?.status === "pending") {
        setMessage({ tone: "info", text: result.error });
      } else if (result?.status === "failed") {
        setMessage({ tone: "error", text: result.error || "Payment was not completed." });
      }
    } catch (err) {
      setMessage({ tone: "error", text: platformCheckoutError(err) });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={`au-scope ${className}`.trim()}>
      <AuthSubmit type="button" loading={busy} disabled={gate.blocked} disabledReason={gate.reason} onClick={run} data-plan={plan?.key}>
        {gate.blocked ? `${label} (coming soon)` : label}
      </AuthSubmit>
      {message ? (
        <AuthMessage tone={message.tone}>{message.text}</AuthMessage>
      ) : null}
    </div>
  );
}
