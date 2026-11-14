import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { fetchTerms } from "../api/auth";
import { registerPushSubscription } from "../api/notifications";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { requestNotificationPermission, subscribeToBrowserPush } from "../utils/pushNotifications";

const fallbackTerms = {
  title: "Terms and Conditions",
  version: "2026-04-18-notifications",
  last_updated: "April 18, 2026",
  body: "Terms and Conditions must be accepted before continuing.",
};

export default function TermsGate() {
  const { user, loading, acceptTerms, logout, webPushEnabled, webPushPublicKey } = useAuth();
  const location = useLocation();
  const [terms, setTerms] = useState(fallbackTerms);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const acceptanceRequired = Boolean(user?.terms_acceptance_required);
  const isTermsPage = location.pathname === "/terms";

  useEffect(() => {
    if (!acceptanceRequired) {
      return;
    }
    let isActive = true;
    fetchTerms()
      .then((response) => {
        if (isActive) {
          setTerms(apiData(response, fallbackTerms));
        }
      })
      .catch(() => {
        if (isActive) {
          setTerms(fallbackTerms);
        }
      });
    return () => {
      isActive = false;
    };
  }, [acceptanceRequired]);

  if (loading || !acceptanceRequired || isTermsPage) {
    return null;
  }

  const handleAccept = async () => {
    if (!checked) {
      setError("You must tick the agreement checkbox before continuing.");
      return;
    }
    setSubmitting(true);
    setError("");
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
          // Terms acceptance must not be blocked by a browser push failure.
        }
      }
    } catch (err) {
      setError(apiMessage(err, "Unable to save Terms acceptance."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] overflow-y-auto overscroll-contain bg-black/90 px-3 py-3 backdrop-blur-md sm:px-4 sm:py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-gate-title"
        aria-describedby="terms-gate-lead"
        className="mx-auto max-w-4xl overflow-hidden rounded-[10px] border border-white/10 bg-[#0a0a0a] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="border-b border-white/10 px-5 py-6 sm:px-8 sm:py-8">
          <p className="flex items-center gap-3 text-xs font-medium uppercase tracking-[0.22em] text-[#8a8a8a]">
            <span className="text-[#F3E2B3]">Required</span>
            <span className="h-px w-8 bg-white/20" aria-hidden="true" />
            <span>Legal consent</span>
          </p>
          <h2 id="terms-gate-title" className="mt-4 text-3xl font-normal leading-none text-white sm:text-5xl">
            Accept the Terms to continue
          </h2>
          <p id="terms-gate-lead" className="mt-3 max-w-2xl text-sm leading-6 text-[#a1a1a1]">
            Every account must accept the current AlsyedInitiative Terms and Conditions before using the platform.
          </p>
        </div>

        <div className="grid gap-5 p-5 sm:gap-6 sm:p-8 lg:grid-cols-[1fr_280px]">
          <section
            aria-label="Terms and Conditions text"
            tabIndex={0}
            className="max-h-[48vh] overflow-y-auto overscroll-contain rounded-[10px] border border-white/10 bg-black p-4 sm:min-h-[360px] sm:max-h-[58vh] sm:p-5"
          >
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[#a1a1a1]">
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono tabular-nums">
                Version {terms.version}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1">
                Updated {terms.last_updated}
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[#d4d4d4]">
              {terms.body}
            </pre>
          </section>

          <aside className="flex flex-col">
            <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-[#8a8a8a]">
              Agreement
            </h3>
            <p className="mt-3 text-sm leading-6 text-[#a1a1a1]">
              By clicking I Agree, your account, timestamp, IP address, browser details, Terms version, and platform notification consent will be stored as a consent record.
            </p>
            <p className="mt-3 text-xs leading-5 text-[#8a8a8a]">
              Browser push permission is optional. You can deny the browser prompt and still continue using the platform.
            </p>
            <label className="mt-5 flex cursor-pointer items-start gap-3 border-t border-white/10 pt-5 text-sm leading-6 text-[#d4d4d4]">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 shrink-0 accent-white"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
              <span>I have read, understood, and agree to the Terms and Conditions. I understand browser push notifications are optional.</span>
            </label>
            {error ? (
              <div role="alert" className="mt-4 flex items-start gap-2 rounded-md bg-[#fafafa] px-3 py-2 text-sm font-medium text-black">
                {error}
              </div>
            ) : null}
            <div className="mt-5 grid gap-2">
              <button
                type="button"
                disabled={!checked || submitting}
                aria-busy={submitting ? "true" : undefined}
                onClick={handleAccept}
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-[#F3E2B3] px-6 text-sm font-semibold text-[#0a0a0a] transition-colors duration-150 hover:bg-[#F8EDCF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E2B3] disabled:cursor-not-allowed disabled:border disabled:border-dashed disabled:border-white/25 disabled:bg-white/[0.06] disabled:text-[#a1a1a1]"
              >
                {submitting ? "Loading..." : "I Agree"}
              </button>
              <Link
                to="/terms"
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-white/20 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-white/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E2B3]"
              >
                Open Full Terms Page
              </Link>
              <button
                type="button"
                onClick={logout}
                className="min-h-11 rounded-md px-4 py-2 text-sm font-medium text-[#a1a1a1] underline-offset-4 transition-colors duration-150 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F3E2B3]"
              >
                Logout
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
