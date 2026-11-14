import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fetchTerms } from "../api/auth";
import { registerPushSubscription } from "../api/notifications";
import { useAuth } from "../hooks/useAuth";
import { Band, Button, Column, Skeleton } from "../site-kit";
import { apiData, apiMessage } from "../utils/api";
import { requestNotificationPermission, subscribeToBrowserPush } from "../utils/pushNotifications";
import { ArrowRight } from "./landing/LandingParts";
import "./landing/sitePages.css";

const fallbackTerms = {
  title: "Terms and Conditions",
  version: "2026-04-18-notifications",
  last_updated: "April 18, 2026",
  body: "Terms and Conditions are temporarily unavailable. Please try again.",
};

export default function TermsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, acceptTerms, webPushEnabled, webPushPublicKey } = useAuth();
  const [terms, setTerms] = useState(fallbackTerms);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState({ error: "", success: "" });

  const acceptanceRequired = Boolean(user?.terms_acceptance_required);

  useEffect(() => {
    let isActive = true;
    fetchTerms()
      .then((response) => {
        if (isActive) {
          setTerms(apiData(response, fallbackTerms));
        }
      })
      .catch((err) => {
        if (isActive) {
          setStatus({ error: apiMessage(err, "Unable to load Terms."), success: "" });
        }
      })
      .finally(() => {
        if (isActive) {
          setLoading(false);
        }
      });
    return () => {
      isActive = false;
    };
  }, []);

  const handleAccept = async () => {
    if (!checked) {
      setStatus({ error: "Tick the agreement checkbox before continuing.", success: "" });
      return;
    }
    setSubmitting(true);
    setStatus({ error: "", success: "" });
    try {
      await acceptTerms({ accepted: true, terms_version: terms.version });
      if (webPushEnabled && webPushPublicKey) {
        try {
          const pushPermission = await requestNotificationPermission();
          if (pushPermission === "granted") {
            const subscription = await subscribeToBrowserPush(webPushPublicKey);
            if (subscription) {
              await registerPushSubscription(subscription);
            }
          }
        } catch {
          // Browser push is best-effort; Terms acceptance and in-app notifications remain active.
        }
      }
      setStatus({ error: "", success: "Terms accepted. You can continue using the platform." });
      navigate(location.state?.from || "/", { replace: true });
    } catch (err) {
      setStatus({ error: apiMessage(err, "Unable to save Terms acceptance."), success: "" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sp sp-terms">
      <Band theme="g100" labelledBy="sp-terms-title">
        <Column sm={4} md={8} lg={11}>
          <p className="sp-eyebrow sp-eyebrow--draw">Legal</p>
          <h1 id="sp-terms-title" className="sp-title">
            {terms.title}
          </h1>
          <p className="sp-lead">
            Last updated {terms.last_updated}. Version <span className="sp-code">{terms.version}</span>
          </p>
        </Column>

        <Column sm={4} md={8} lg={10} className="sp-terms__body">
          {loading ? (
            <Skeleton lines={8} label="Loading the Terms" />
          ) : (
            <article className="sp-terms__text" aria-label="Terms and Conditions text">
              {terms.body}
            </article>
          )}
        </Column>

        <Column sm={4} md={8} lg={5} start={12} className="sp-terms__aside">
          <section className="sp-panel" aria-labelledby="sp-terms-consent">
            <h2 id="sp-terms-consent" className="sp-h2">
              Your consent
            </h2>
            {user ? (
              <>
                <p className="sp-terms__meta">
                  Signed in as <strong>{user.email}</strong>
                </p>
                {acceptanceRequired ? (
                  <>
                    <label className="sp-check">
                      <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
                      <span>
                        I have read, understood, and agree to these Terms and Conditions. I understand browser push
                        notifications are optional.
                      </span>
                    </label>
                    <Button
                      fullWidth
                      disabled={!checked}
                      disabledReason={!checked ? "Tick the agreement first." : ""}
                      loading={submitting}
                      onClick={handleAccept}
                      icon={<ArrowRight />}
                    >
                      I Agree
                    </Button>
                  </>
                ) : (
                  <p className="sp-message sp-message--success" role="status">
                    Accepted. Your account has agreed to the current version.
                  </p>
                )}
                <p className="sp-field__hint sp-terms__note">
                  Browser push permission is optional. You can deny the prompt and still continue; the bell keeps your
                  notifications inside the platform.
                </p>
              </>
            ) : (
              <>
                <p className="sp-terms__meta">Sign in to accept these Terms for your account.</p>
                <Button href="/login" kind="secondary" fullWidth icon={<ArrowRight />}>
                  Sign in to accept
                </Button>
              </>
            )}

            {status.error ? (
              <p className="sp-message sp-message--error" role="alert">
                {status.error}
              </p>
            ) : null}
            {status.success ? (
              <p className="sp-message sp-message--success" role="status">
                {status.success}
              </p>
            ) : null}
          </section>
        </Column>
      </Band>
    </div>
  );
}
