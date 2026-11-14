import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";
import TurnstileWidget from "../components/TurnstileWidget";
import { useTurnstileChallenge } from "../hooks/useTurnstileChallenge";
import { useAuth } from "../hooks/useAuth";
import { AuthField, AuthMessage, AuthSubmit } from "../marketing/auth/AuthControls";
import AuthSplit from "../marketing/auth/AuthSplit";
import { apiMessage } from "../utils/api";
import { returnTargetFromSearch } from "../utils/safeReturnUrl";

/** Where a sign-in lands without a return address (plan D3): staff in Admin, everyone else in the Console. */
export const STAFF_HOME = "/console/admin";
export const LEARNER_HOME = "/console";

export function homeAfterLogin(user) {
  return user?.is_admin ? STAFF_HOME : LEARNER_HOME;
}

/** Headline and sub-line for each step of the sign-in (our words). */
export function loginCopy({ needs2FA = false, returningToLabs = false } = {}) {
  if (needs2FA) {
    return {
      title: "One more step",
      sub: "Your password was accepted. Enter the 6-digit code from your authenticator app.",
    };
  }
  return {
    title: "Sign in",
    sub: returningToLabs ? "Sign in to continue to Al Syed Labs." : "Pick up where you paused.",
  };
}

function normalizeEmailInput(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function hasEdgeWhitespace(value) {
  return /^\s|\s$/.test(String(value || ""));
}

export default function LoginPage() {
  const {
    login,
    turnstileEnabled,
    turnstileSiteKey,
    sessionEndedMessage,
    isAuthenticated,
    loading: authLoading,
    user,
  } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // A protected page that sent the visitor here wins; otherwise the role's home.
  const redirectFrom = location.state?.from || "";
  // ?next= (e.g. from labs.alsyedinitiative.com): only in-app paths or the trusted labs site.
  const returnTarget = returnTargetFromSearch(location.search);
  // The labs site can only use the account once the current Terms are
  // accepted here (its API calls answer 403 "terms" until then). The Terms
  // gate shows on this page; the effect below returns to labs after "I Agree".
  const termsPending = Boolean(user?.terms_acceptance_required);

  const goAfterLogin = (signedInUser) => {
    if (returnTarget?.type === "external") {
      if (signedInUser?.terms_acceptance_required) return;
      window.location.assign(returnTarget.href);
      return;
    }
    navigate(returnTarget?.path || redirectFrom || homeAfterLogin(signedInUser), { replace: true });
  };

  // Already signed in and sent here with a return address: go straight back.
  useEffect(() => {
    if (!authLoading && isAuthenticated && returnTarget) {
      if (returnTarget.type === "external") {
        if (!termsPending) window.location.replace(returnTarget.href);
      } else navigate(returnTarget.path, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, isAuthenticated, termsPending]);
  const turnstile = useTurnstileChallenge(turnstileEnabled);
  const [form, setForm] = useState({ email: "", password: "", otp_code: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState(sessionEndedMessage || "");
  const [emailWhitespaceWarning, setEmailWhitespaceWarning] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);

  const setNormalizedEmail = (value, { fromPaste = false } = {}) => {
    const rawValue = String(value || "");
    const normalizedValue = normalizeEmailInput(rawValue);
    setEmailWhitespaceWarning(
      hasEdgeWhitespace(rawValue)
        ? `Email ${fromPaste ? "paste" : "input"} had a space before or after it. The extra space was removed automatically.`
        : ""
    );
    setForm((prev) => ({ ...prev, email: normalizedValue }));
  };

  const passwordWhitespaceWarning = hasEdgeWhitespace(form.password)
    ? "Password contains a space before or after it. If that was not intentional, remove the extra space before logging in."
    : "";

  const hasWhitespaceWarning = Boolean(emailWhitespaceWarning || passwordWhitespaceWarning);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const securityError = turnstile.requireToken();
    if (securityError) {
      setError(securityError);
      setInfo("");
      return;
    }
    setLoading(true);
    setError("");
    setInfo("");
    try {
      const normalizedEmail = normalizeEmailInput(form.email);
      if (normalizedEmail !== form.email) {
        setNormalizedEmail(normalizedEmail);
      }
      const signedInUser = await login({
        email: normalizedEmail,
        password: form.password,
        ...(needs2FA ? { otp_code: form.otp_code } : {}),
        ...turnstile.payload,
      });
      goAfterLogin(signedInUser);
    } catch (err) {
      const requires2FA = Boolean(err?.response?.data?.errors?.requires_2fa);
      const detail = err?.response?.data?.errors?.detail;
      if (requires2FA) {
        setNeeds2FA(true);
        setInfo("Enter the 2FA code from your authenticator app to complete login.");
      }
      setError(detail || apiMessage(err, "Login failed."));
      turnstile.reset();
    } finally {
      setLoading(false);
    }
  };

  const handleResetRequest = async () => {
    const normalizedEmail = normalizeEmailInput(form.email);
    if (!normalizedEmail) {
      setError("Enter your email first.");
      return;
    }
    const securityError = turnstile.requireToken();
    if (securityError) {
      setError(securityError);
      setInfo("");
      return;
    }
    setError("");
    setInfo("");
    try {
      if (normalizedEmail !== form.email) {
        setNormalizedEmail(normalizedEmail);
      }
      await requestPasswordReset({ email: normalizedEmail, ...turnstile.payload });
      setInfo("Password reset request sent (or stubbed if email provider is not configured).");
      turnstile.reset();
    } catch (err) {
      setError(apiMessage(err, "Unable to request password reset."));
      turnstile.reset();
    }
  };

  const returningToLabs = returnTarget?.type === "external";
  const copy = loginCopy({ needs2FA, returningToLabs });
  const securityPending = Boolean(turnstileEnabled && !turnstile.token);

  return (
    <AuthSplit
      labelledBy="au-login-title"
      corner={
        <Link to="/courses" className="au-corner">
          Browse courses
        </Link>
      }
      foot={<p>Accounts are created by the Al Syed team after verification.</p>}
    >
      <h1 id="au-login-title" className="au-title">
        {copy.title}
      </h1>
      <p className="au-sub">{copy.sub}</p>

      <form onSubmit={handleSubmit} className="au-form" noValidate={false}>
        <div className="au-grid au-grid--2">
          <div>
            <AuthField
              label="Email"
              type="email"
              name="email"
              autoComplete="username"
              placeholder="you@example.com"
              value={form.email}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setNormalizedEmail(e.target.value)}
              onBlur={(e) => setNormalizedEmail(e.target.value)}
              onPaste={(e) => {
                const pastedText = e.clipboardData?.getData("text");
                if (!pastedText) return;
                e.preventDefault();
                setNormalizedEmail(pastedText, { fromPaste: true });
              }}
              required
            />
          </div>
          <div>
            <AuthField
              label="Password"
              name="password"
              reveal
              autoComplete="current-password"
              placeholder="Your password"
              value={form.password}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              required
            />
            <div className="au-row">
              <button type="button" onClick={handleResetRequest} className="au-textbtn">
                Forgot password?
              </button>
            </div>
          </div>
          {needs2FA ? (
            <div className="au-span-2">
              <AuthField
                label="Authenticator code (2FA)"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={form.otp_code}
                onChange={(e) => setForm((prev) => ({ ...prev, otp_code: e.target.value.replace(/\s+/g, "") }))}
                required
                autoFocus
              />
              <div className="au-row">
                <Link to="/contact" className="au-link">
                  Lost access to your authenticator?
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        {error ? <AuthMessage tone="error">{error}</AuthMessage> : null}
        {info ? <AuthMessage tone="info">{info}</AuthMessage> : null}
        {hasWhitespaceWarning ? (
          <AuthMessage tone="warning">
            {emailWhitespaceWarning ? <div>{emailWhitespaceWarning}</div> : null}
            {passwordWhitespaceWarning ? <div>{passwordWhitespaceWarning}</div> : null}
          </AuthMessage>
        ) : null}

        {turnstileEnabled ? (
          <div className="au-turnstile">
            <TurnstileWidget
              siteKey={turnstileSiteKey}
              action="auth"
              onToken={turnstile.setToken}
              onExpire={turnstile.expire}
              onError={() => {
                turnstile.expire();
                setError("Security check failed to load. Refresh the page and try again.");
              }}
              resetSignal={turnstile.resetSignal}
            />
          </div>
        ) : null}

        <div className="au-submit-wrap">
          <AuthSubmit
            loading={loading}
            disabled={securityPending}
            disabledReason={securityPending ? "Complete the security check first." : ""}
          >
            {needs2FA ? "Verify & Login" : "Login"}
          </AuthSubmit>
        </div>
      </form>
    </AuthSplit>
  );
}
