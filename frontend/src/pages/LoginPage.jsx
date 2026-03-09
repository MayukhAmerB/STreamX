import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";
import Button from "../components/Button";
import BrandLogo from "../components/BrandLogo";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiMessage } from "../utils/api";

export default function LoginPage() {
  const { login, googleLogin, registrationEnabled, googleLoginEnabled } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || "/";
  const [form, setForm] = useState({ email: "", password: "", otp_code: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);
  const frontendGoogleOAuthEnabled = Boolean(
    import.meta.env.VITE_GOOGLE_CLIENT_ID && String(import.meta.env.VITE_GOOGLE_CLIENT_ID).trim().toLowerCase() !== "disabled"
  );
  const showGoogleLogin = Boolean(googleLoginEnabled && frontendGoogleOAuthEnabled);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setInfo("");
    try {
      await login({
        email: form.email,
        password: form.password,
        ...(needs2FA ? { otp_code: form.otp_code } : {}),
      });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      const requires2FA = Boolean(err?.response?.data?.errors?.requires_2fa);
      const detail = err?.response?.data?.errors?.detail;
      if (requires2FA) {
        setNeeds2FA(true);
        setInfo("Enter the 2FA code from your authenticator app to complete login.");
      }
      setError(detail || apiMessage(err, "Login failed."));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse) => {
    setError("");
    try {
      await googleLogin(credentialResponse?.credential);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(apiMessage(err, "Google login failed."));
    }
  };

  const handleResetRequest = async () => {
    if (!form.email) {
      setError("Enter your email first.");
      return;
    }
    setError("");
    setInfo("");
    try {
      await requestPasswordReset({ email: form.email });
      setInfo("Password reset request sent (or stubbed if email provider is not configured).");
    } catch (err) {
      setError(apiMessage(err, "Unable to request password reset."));
    }
  };

  return (
    <PageShell title="" subtitle="">
      <section className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-black bg-[#080808] shadow-[0_28px_70px_rgba(0,0,0,0.45)]">
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-black" />
          <div className="absolute inset-0 bg-[radial-gradient(88%_78%_at_100%_0%,rgba(255,255,255,0.24)_0%,rgba(255,255,255,0.11)_24%,rgba(255,255,255,0.045)_42%,rgba(255,255,255,0)_68%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(0,0,0,0)_58%,rgba(255,255,255,0.025)_76%,rgba(255,255,255,0.08)_100%)]" />
          <div className="absolute inset-0 opacity-10 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:24px_24px]" />
        </div>

        <div className="relative grid gap-6 p-4 sm:p-6 lg:grid-cols-[1.03fr_0.97fr] lg:gap-8">
          <div className="hidden rounded-[26px] border border-black panel-gradient p-6 backdrop-blur-sm lg:block">
            <div className="rounded-[22px] border border-black panel-gradient p-4 shadow-[0_16px_44px_rgba(0,0,0,0.24)]">
              <div className="flex items-start justify-between gap-4">
                <BrandLogo className="max-w-[260px]" />
                <div className="rounded-2xl border border-black panel-gradient px-4 py-3 text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#949494]">
                    AUTH STATE
                  </div>
                  <div className="mt-2 text-sm font-semibold text-[#E0E0E0]">SECURE GATEWAY</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {["EMAIL", "PASSWORD", "2FA", "ENROLLED ACCESS"].map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-black bg-[#151515] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#DBDBDB]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DBDBDB]">
              SECURE LOGIN
            </div>

            <h1 className="mt-4 font-reference text-4xl font-semibold leading-tight text-white">
              Access the training platform through a controlled login path
            </h1>
            <p className="mt-3 max-w-md text-sm leading-7 text-[#BBBBBB]">
              Continue your OSINT and web application pentesting workflow with protected course access,
              instructor-led live sessions, and optional authenticator-based verification.
            </p>

            <div className="mt-6 grid gap-3">
              {[
                "Course access is issued to enrolled students only",
                "Live class permissions stay linked to your account",
                "Authenticator-based 2FA can harden the session",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-black panel-gradient px-3 py-3 text-sm text-[#C9C9C9]"
                >
                  <span className="mt-1 h-2.5 w-2.5 rounded-full bg-[#C0C0C0]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-black bg-[#121212]/95 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
                Authentication Flow
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {["Email", "Password", "2FA (Optional)"].map((step, idx) => (
                  <div key={step} className="rounded-xl border border-black panel-gradient p-3">
                    <div className="text-xs font-semibold text-[#E0E0E0]">{`0${idx + 1}`}</div>
                    <div className="mt-1 text-xs text-[#AFAFAF]">{step}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-black panel-gradient p-5 shadow-[0_16px_44px_rgba(0,0,0,0.32)] backdrop-blur-sm sm:p-6">
            <div className="mb-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-black bg-[#141414] px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DCDCDC]">
                {needs2FA ? "2FA REQUIRED" : "LOGIN"}
              </div>
              <h2 className="mt-3 font-reference text-2xl font-semibold text-white sm:text-3xl">
                {needs2FA ? "Enter your authenticator code" : "Welcome back"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                {needs2FA
                  ? "Your password was accepted. Complete login using the 6-digit code from your authenticator app."
                  : "Access your student or instructor dashboard securely."}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <FormInput
                label="Email"
                type="email"
                placeholder="you@example.com"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                required
              />
              <FormInput
                label="Password"
                type="password"
                placeholder="Enter your password"
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                required
              />
              {needs2FA ? (
                <FormInput
                  label="Authenticator Code (2FA)"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={form.otp_code}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, otp_code: e.target.value.replace(/\s+/g, "") }))
                  }
                  required
                />
              ) : null}

              {error ? (
                <div className="rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              ) : null}
              {info ? (
                <div className="rounded-xl border border-zinc-400/20 bg-zinc-500/10 px-3 py-2 text-sm text-zinc-200">
                  {info}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={handleResetRequest}
                  className="text-xs font-medium text-[#BBBBBB] transition hover:text-white"
                >
                  Forgot password?
                </button>
                <span className="text-[11px] uppercase tracking-[0.12em] text-[#8D8D8D]">
                  Secure session
                </span>
              </div>

              <Button className="w-full rounded-xl py-2.5" type="submit" loading={loading}>
                {needs2FA ? "Verify & Login" : "Login"}
              </Button>
            </form>

            {showGoogleLogin ? (
              <>
                <div className="my-5 flex items-center gap-3 text-xs text-[#8F8F8F]">
                  <div className="h-px flex-1 bg-[#303030]" />
                  <span>OR CONTINUE WITH</span>
                  <div className="h-px flex-1 bg-[#303030]" />
                </div>

                <div className="rounded-xl border border-black bg-[#131313] p-3">
                  <div className="flex justify-center">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={() => setError("Google login failed.")}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="my-5 rounded-xl border border-black bg-[#131313] px-4 py-3 text-xs text-[#949494]">
                Google sign-in is currently disabled.
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black bg-[#131313] px-4 py-3">
              {registrationEnabled ? (
                <p className="text-sm text-[#BBBBBB]">
                  New here?{" "}
                  <Link to="/register" className="font-semibold text-white hover:underline">
                    Create account
                  </Link>
                </p>
              ) : (
                <p className="text-sm text-[#BBBBBB]">
                  Account creation is managed by admin. Use provided credentials.
                </p>
              )}
              <Link
                to="/courses"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-[#DBDBDB] hover:text-white"
              >
                Browse Courses
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}


