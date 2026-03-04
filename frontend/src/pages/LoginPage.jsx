import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { requestPasswordReset } from "../api/auth";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiMessage } from "../utils/api";

const authBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

export default function LoginPage() {
  const { login, googleLogin, registrationEnabled } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.from || "/";
  const [form, setForm] = useState({ email: "", password: "", otp_code: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [needs2FA, setNeeds2FA] = useState(false);

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
      <section className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] border border-[#d5deca]/10 bg-[#070907] shadow-[0_28px_70px_rgba(0,0,0,0.45)]">
        <div className="absolute inset-0">
          <img
            src={authBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.18] grayscale"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/92 via-black/85 to-[#0a0f0b]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_18%,rgba(185,199,171,0.12),transparent_40%)]" />
          <div className="absolute inset-0 opacity-10 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:24px_24px]" />
        </div>

        <div className="relative grid gap-6 p-4 sm:p-6 lg:grid-cols-[1.03fr_0.97fr] lg:gap-8">
          <div className="hidden rounded-2xl border border-[#243025] bg-[#0d120f]/72 p-6 backdrop-blur-sm lg:block">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#334033] bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#d7e0cc]">
              SECURE LOGIN
            </div>

            <h1 className="mt-4 font-reference text-4xl font-semibold leading-tight text-white">
              Access your Alsyed Academy account
            </h1>
            <p className="mt-3 max-w-md text-sm leading-7 text-[#b7c0b0]">
              Continue your OSINT and web application pentesting learning path with protected access,
              course purchases, and live class enrollment.
            </p>

            <div className="mt-6 grid gap-3">
              {[
                "Course access for enrolled students only",
                "Live classes enrollment linked to your account",
                "Optional 2FA with authenticator app support",
              ].map((item) => (
                <div
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-[#202920] bg-[#101610]/90 px-3 py-3 text-sm text-[#c5ceb9]"
                >
                  <span className="mt-1 h-2.5 w-2.5 rounded-full bg-[#b9c7ab]" />
                  <span>{item}</span>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-[#2a332d] bg-[#0f1410]/95 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8f9989]">
                Authentication Flow
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {["Email", "Password", "2FA (Optional)"].map((step, idx) => (
                  <div key={step} className="rounded-xl border border-[#1f2820] bg-[#111612] p-3">
                    <div className="text-xs font-semibold text-[#dce4d2]">{`0${idx + 1}`}</div>
                    <div className="mt-1 text-xs text-[#aab4a3]">{step}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#d5deca]/12 bg-[#0d120f]/92 p-5 shadow-[0_16px_44px_rgba(0,0,0,0.32)] backdrop-blur-sm sm:p-6">
            <div className="mb-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-[#2c362d] bg-[#111612] px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#d8e1cf]">
                {needs2FA ? "2FA REQUIRED" : "LOGIN"}
              </div>
              <h2 className="mt-3 font-reference text-2xl font-semibold text-white sm:text-3xl">
                {needs2FA ? "Enter your authenticator code" : "Welcome back"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">
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
                <div className="rounded-xl border border-green-300/20 bg-green-500/10 px-3 py-2 text-sm text-green-200">
                  {info}
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={handleResetRequest}
                  className="text-xs font-medium text-[#b7c0b0] transition hover:text-white"
                >
                  Forgot password?
                </button>
                <span className="text-[11px] uppercase tracking-[0.12em] text-[#879284]">
                  Secure session
                </span>
              </div>

              <Button className="w-full rounded-xl py-2.5" type="submit" loading={loading}>
                {needs2FA ? "Verify & Login" : "Login"}
              </Button>
            </form>

            <div className="my-5 flex items-center gap-3 text-xs text-[#889486]">
              <div className="h-px flex-1 bg-[#2a332d]" />
              <span>OR CONTINUE WITH</span>
              <div className="h-px flex-1 bg-[#2a332d]" />
            </div>

            <div className="rounded-xl border border-[#232c24] bg-[#101510] p-3">
              <div className="flex justify-center">
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => setError("Google login failed.")}
                />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#232c24] bg-[#101510] px-4 py-3">
              {registrationEnabled ? (
                <p className="text-sm text-[#b7c0b0]">
                  New here?{" "}
                  <Link to="/register" className="font-semibold text-white hover:underline">
                    Create account
                  </Link>
                </p>
              ) : (
                <p className="text-sm text-[#b7c0b0]">
                  Account creation is managed by admin. Use provided credentials.
                </p>
              )}
              <Link
                to="/courses"
                className="text-xs font-semibold uppercase tracking-[0.12em] text-[#d7e0cc] hover:text-white"
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

