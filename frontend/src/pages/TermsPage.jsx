import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { fetchTerms } from "../api/auth";
import { registerPushSubscription } from "../api/notifications";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { requestNotificationPermission, subscribeToBrowserPush } from "../utils/pushNotifications";

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
    <PageShell
      title={terms.title}
      subtitle={`Last updated ${terms.last_updated}. Active version ${terms.version}.`}
    >
      <section className="mx-auto max-w-5xl overflow-hidden rounded-[28px] border border-black bg-[#080808] shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
        <div className="border-b border-white/10 bg-gradient-to-r from-[#151515] via-[#101010] to-[#1F1F1F] px-5 py-5 sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#BDBDBD]">
            Legal Document
          </p>
          <h1 className="mt-2 font-reference text-3xl font-semibold text-white">
            AlsyedInitiative Terms and Conditions
          </h1>
          <p className="mt-2 text-sm leading-6 text-[#C7C7C7]">
            Read this document carefully. Continued platform access requires affirmative consent.
          </p>
        </div>

        <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-[1fr_300px]">
          <article className="rounded-2xl border border-white/10 bg-black/45 p-4 sm:p-5">
            {loading ? (
              <p className="text-sm text-[#BBBBBB]">Loading Terms...</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[#DCDCDC]">
                {terms.body}
              </pre>
            )}
          </article>

          <aside className="h-fit rounded-2xl border border-white/10 bg-[#121212] p-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[#E6E6E6]">
              Consent Status
            </h2>
            {user ? (
              <>
                <p className="mt-3 text-sm leading-6 text-[#BFBFBF]">
                  Signed in as <span className="font-semibold text-white">{user.email}</span>.
                </p>
                {acceptanceRequired ? (
                  <>
                    <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3 text-sm leading-6 text-[#E3E3E3]">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-white"
                        checked={checked}
                        onChange={(event) => setChecked(event.target.checked)}
                      />
                      <span>I have read, understood, and agree to these Terms and Conditions. I understand browser push notifications are optional.</span>
                    </label>
                    <Button
                      type="button"
                      className="mt-4 w-full"
                      disabled={!checked}
                      loading={submitting}
                      onClick={handleAccept}
                    >
                      I Agree
                    </Button>
                  </>
                ) : (
                  <div className="mt-4 rounded-xl border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                    Your account has accepted the current Terms version.
                  </div>
                )}
                <p className="mt-3 text-xs leading-5 text-[#9F9F9F]">
                  Browser push permission is optional. You can deny the prompt and still continue; bell notifications remain available inside the platform.
                </p>
              </>
            ) : (
              <div className="mt-3 space-y-3 text-sm leading-6 text-[#BFBFBF]">
                <p>Sign in to accept these Terms for your account.</p>
                <Link to="/login" className="block">
                  <Button className="w-full">Login to Accept</Button>
                </Link>
              </div>
            )}

            {status.error ? (
              <div className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {status.error}
              </div>
            ) : null}
            {status.success ? (
              <div className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
                {status.success}
              </div>
            ) : null}
          </aside>
        </div>
      </section>
    </PageShell>
  );
}
