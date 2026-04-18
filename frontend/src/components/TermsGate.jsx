import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { fetchTerms } from "../api/auth";
import { registerPushSubscription } from "../api/notifications";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { requestNotificationPermission, subscribeToBrowserPush } from "../utils/pushNotifications";
import Button from "./Button";

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
    <div className="fixed inset-0 z-[1000] overflow-y-auto bg-black/86 px-4 py-6 backdrop-blur-xl">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-[28px] border border-white/15 bg-[#080808] shadow-[0_32px_90px_rgba(0,0,0,0.72)]">
        <div className="border-b border-white/10 bg-gradient-to-r from-[#151515] via-[#101010] to-[#1F1F1F] px-5 py-5 sm:px-7">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#BDBDBD]">
            Required Legal Consent
          </p>
          <h2 className="mt-2 font-reference text-2xl font-semibold text-white sm:text-3xl">
            Accept the Terms to continue
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#C7C7C7]">
            Every account must accept the current AlsyedInitiative Terms and Conditions before using the platform.
          </p>
        </div>

        <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-[1fr_280px]">
          <section className="min-h-[360px] max-h-[58vh] overflow-y-auto rounded-2xl border border-white/10 bg-black/45 p-4">
            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[#AFAFAF]">
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                Version {terms.version}
              </span>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                Updated {terms.last_updated}
              </span>
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-[#D9D9D9]">
              {terms.body}
            </pre>
          </section>

          <aside className="rounded-2xl border border-white/10 bg-[#121212] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-[#E6E6E6]">
              Agreement
            </h3>
            <p className="mt-3 text-sm leading-6 text-[#BFBFBF]">
              By clicking I Agree, your account, timestamp, IP address, browser details, Terms version, and platform notification consent will be stored as a consent record.
            </p>
            <p className="mt-3 text-xs leading-5 text-[#9F9F9F]">
              Browser push permission is optional. You can deny the browser prompt and still continue using the platform.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/30 p-3 text-sm leading-6 text-[#E3E3E3]">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-white"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
              <span>I have read, understood, and agree to the Terms and Conditions. I understand browser push notifications are optional.</span>
            </label>
            {error ? (
              <div className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {error}
              </div>
            ) : null}
            <div className="mt-4 grid gap-2">
              <Button type="button" disabled={!checked} loading={submitting} onClick={handleAccept}>
                I Agree
              </Button>
              <Link
                to="/terms"
                className="inline-flex min-h-10 items-center justify-center rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Open Full Terms Page
              </Link>
              <button
                type="button"
                onClick={logout}
                className="min-h-10 rounded-xl border border-red-300/20 px-4 py-2 text-sm font-semibold text-red-200 transition hover:bg-red-500/10"
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
